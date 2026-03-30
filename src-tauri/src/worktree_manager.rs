use git2::{BranchType, Delta, Diff, DiffOptions, Repository, StatusOptions};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

// --- Structs ---

#[derive(Clone, Serialize)]
pub struct GitInfo {
    pub branch: String,
    pub repo_root: String,
    pub is_worktree: bool,
}

#[derive(Clone, Serialize)]
pub struct RepoSummary {
    pub info: GitInfo,
    pub active_worktree_count: usize,
}

#[derive(Clone, Serialize)]
pub struct WorktreeResult {
    pub path: String,
    pub branch: String,
}

#[derive(Clone, Serialize)]
pub struct WorktreeStatus {
    pub has_changes: bool,
}

struct ManagedWorktree {
    #[allow(dead_code)]
    session_id: String,
    worktree_path: String,
    #[allow(dead_code)]
    branch_name: String,
    repo_root: String,
}

static WORKTREE_MAP: std::sync::LazyLock<Mutex<HashMap<String, ManagedWorktree>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

// --- Commands ---

#[tauri::command]
pub fn get_git_info(cwd: String) -> Result<Option<RepoSummary>, String> {
    let repo = match Repository::discover(&cwd) {
        Ok(r) => r,
        Err(_) => return Ok(None), // Not a git repo
    };

    let repo_root = repo
        .workdir()
        .or_else(|| repo.path().parent())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // Determine if this is a worktree
    let is_worktree = repo.is_worktree();

    // Get current branch name
    let branch = match repo.head() {
        Ok(head) => {
            if head.is_branch() {
                head.shorthand().unwrap_or("HEAD").to_string()
            } else {
                // Detached HEAD — show short hash
                head.target()
                    .map(|oid| format!("{:.7}", oid))
                    .unwrap_or_else(|| "HEAD".to_string())
            }
        }
        Err(_) => "HEAD".to_string(),
    };

    // Count managed worktrees for this repo
    let canonical_root = std::fs::canonicalize(&repo_root)
        .unwrap_or_else(|_| std::path::PathBuf::from(&repo_root))
        .to_string_lossy()
        .to_string();

    let active_worktree_count = WORKTREE_MAP
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .filter(|wt| {
            let wt_root = std::fs::canonicalize(&wt.repo_root)
                .unwrap_or_else(|_| std::path::PathBuf::from(&wt.repo_root))
                .to_string_lossy()
                .to_string();
            wt_root == canonical_root
        })
        .count();

    Ok(Some(RepoSummary {
        info: GitInfo {
            branch,
            repo_root,
            is_worktree,
        },
        active_worktree_count,
    }))
}

#[tauri::command]
pub fn create_worktree(
    repo_path: String,
    name: String,
    session_id: String,
) -> Result<WorktreeResult, String> {
    let repo = Repository::open(&repo_path).map_err(|e| format!("Failed to open repo: {}", e))?;

    let worktree_dir = Path::new(&repo_path)
        .join(".pane-street")
        .join("worktrees")
        .join(&name);

    std::fs::create_dir_all(&worktree_dir)
        .map_err(|e| format!("Failed to create worktree directory: {}", e))?;

    let branch_name = format!("worktree-{}", name);

    // Get HEAD commit to branch from
    let head = repo
        .head()
        .map_err(|e| format!("Failed to get HEAD: {}", e))?;
    let commit = head
        .peel_to_commit()
        .map_err(|e| format!("Failed to peel to commit: {}", e))?;

    // Create the branch
    repo.branch(&branch_name, &commit, false)
        .map_err(|e| format!("Failed to create branch: {}", e))?;

    // Create the worktree
    // Use git CLI as fallback since git2's worktree API can be tricky
    let output = crate::cmd_util::silent_cmd("git")
        .args([
            "worktree",
            "add",
            worktree_dir.to_str().unwrap_or(""),
            &branch_name,
        ])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Clean up the directory we created
        let _ = std::fs::remove_dir_all(&worktree_dir);
        // Try to delete the branch we created
        if let Ok(mut branch) = repo.find_branch(&branch_name, git2::BranchType::Local) {
            let _ = branch.delete();
        }
        return Err(format!("git worktree add failed: {}", stderr));
    }

    let worktree_path = worktree_dir.to_string_lossy().to_string();

    // Register in our tracking map
    WORKTREE_MAP
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            session_id.clone(),
            ManagedWorktree {
                session_id,
                worktree_path: worktree_path.clone(),
                branch_name: branch_name.clone(),
                repo_root: repo_path,
            },
        );

    Ok(WorktreeResult {
        path: worktree_path,
        branch: branch_name,
    })
}

#[tauri::command]
pub fn check_worktree_status(session_id: String) -> Result<WorktreeStatus, String> {
    let map = WORKTREE_MAP
        .lock()
        .map_err(|e| e.to_string())?;

    let wt = match map.get(&session_id) {
        Some(wt) => wt,
        None => return Ok(WorktreeStatus { has_changes: false }),
    };

    let repo = Repository::open(&wt.worktree_path)
        .map_err(|e| format!("Failed to open worktree repo: {}", e))?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to get status: {}", e))?;

    Ok(WorktreeStatus {
        has_changes: !statuses.is_empty(),
    })
}

#[tauri::command]
pub fn cleanup_worktree(session_id: String, force: bool) -> Result<bool, String> {
    // Check status first if not forcing
    if !force {
        let status = check_worktree_status(session_id.clone())?;
        if status.has_changes {
            return Ok(false); // Dirty, needs confirmation
        }
    }

    let mut map = WORKTREE_MAP
        .lock()
        .map_err(|e| e.to_string())?;

    let wt = match map.remove(&session_id) {
        Some(wt) => wt,
        None => return Ok(true), // Nothing to clean
    };

    // Remove worktree via git CLI (cleaner than manual cleanup)
    let _ = crate::cmd_util::silent_cmd("git")
        .args(["worktree", "remove", "--force", &wt.worktree_path])
        .current_dir(&wt.repo_root)
        .output();

    // Remove the branch
    if let Ok(repo) = Repository::open(&wt.repo_root) {
        if let Ok(mut branch) = repo.find_branch(&wt.branch_name, git2::BranchType::Local) {
            let _ = branch.delete();
        }
    }

    // Clean up empty .pane-street directory structure
    let worktrees_dir = Path::new(&wt.repo_root)
        .join(".pane-street")
        .join("worktrees");
    if worktrees_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&worktrees_dir) {
            if entries.count() == 0 {
                let _ = std::fs::remove_dir_all(
                    Path::new(&wt.repo_root).join(".pane-street"),
                );
            }
        }
    }

    Ok(true)
}

// --- Branch Graph ---

#[derive(Clone, Serialize)]
pub struct BranchNode {
    pub name: String,
    pub is_current: bool,
    pub commit_sha: String,
    pub commit_message: String,
    pub commit_author: String,
    pub commit_time: i64,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Clone, Serialize)]
pub struct CommitInfo {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub time: i64,
}

#[derive(Clone, Serialize)]
pub struct BranchGraph {
    pub default_branch: String,
    pub branches: Vec<BranchNode>,
    pub recent_commits: Vec<CommitInfo>,
}

#[tauri::command]
pub fn get_branch_graph(cwd: String) -> Result<Option<BranchGraph>, String> {
    let repo = match Repository::discover(&cwd) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };

    // Find default branch (main or master)
    let default_branch = ["main", "master"]
        .iter()
        .find(|name| repo.find_branch(name, BranchType::Local).is_ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "main".to_string());

    let default_oid = repo
        .find_branch(&default_branch, BranchType::Local)
        .ok()
        .and_then(|b| b.get().target());

    // Get current branch name
    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(String::from))
        .unwrap_or_default();

    // Iterate local branches
    let mut branches = Vec::new();
    if let Ok(branch_iter) = repo.branches(Some(BranchType::Local)) {
        for item in branch_iter {
            let (branch, _) = match item {
                Ok(b) => b,
                Err(_) => continue,
            };

            let name = match branch.name() {
                Ok(Some(n)) => n.to_string(),
                _ => continue,
            };

            // Skip pane-street worktree branches
            if name.starts_with("worktree-") {
                continue;
            }

            let tip = match branch.get().peel_to_commit() {
                Ok(c) => c,
                Err(_) => continue,
            };

            let tip_oid = tip.id();
            let (ahead, behind) = if let Some(def_oid) = default_oid {
                if tip_oid == def_oid {
                    (0, 0)
                } else {
                    repo.graph_ahead_behind(tip_oid, def_oid).unwrap_or((0, 0))
                }
            } else {
                (0, 0)
            };

            branches.push(BranchNode {
                is_current: name == current_branch,
                name,
                commit_sha: format!("{:.7}", tip_oid),
                commit_message: tip.summary().unwrap_or("").to_string(),
                commit_author: tip.author().name().unwrap_or("").to_string(),
                commit_time: tip.time().seconds(),
                ahead,
                behind,
            });
        }
    }

    // Sort: current branch first, then by most recent commit
    branches.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(b.commit_time.cmp(&a.commit_time))
    });

    // Get recent commits on current branch (limit 8)
    let mut recent_commits = Vec::new();
    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            if let Ok(mut revwalk) = repo.revwalk() {
                let _ = revwalk.push(oid);
                revwalk.set_sorting(git2::Sort::TIME).ok();

                for (i, rev_oid) in revwalk.flatten().enumerate() {
                    if i >= 8 {
                        break;
                    }
                    if let Ok(commit) = repo.find_commit(rev_oid) {
                        recent_commits.push(CommitInfo {
                            sha: format!("{:.7}", commit.id()),
                            message: commit.summary().unwrap_or("").to_string(),
                            author: commit.author().name().unwrap_or("").to_string(),
                            time: commit.time().seconds(),
                        });
                    }
                }
            }
        }
    }

    Ok(Some(BranchGraph {
        default_branch,
        branches,
        recent_commits,
    }))
}

// --- Git Diff Stats ---

#[derive(Clone, Serialize)]
pub struct FileDiffStat {
    pub path: String,
    pub abs_path: String,
    pub additions: usize,
    pub deletions: usize,
    pub status: String,
}

#[derive(Clone, Serialize)]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLineInfo>,
}

#[derive(Clone, Serialize)]
pub struct DiffLineInfo {
    pub kind: String,
    pub content: String,
    pub new_lineno: Option<u32>,
    pub old_lineno: Option<u32>,
}

#[derive(Clone, Serialize)]
pub struct FileDiffDetail {
    pub path: String,
    pub hunks: Vec<DiffHunk>,
}

fn delta_status_str(delta: Delta) -> &'static str {
    match delta {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Modified => "modified",
        Delta::Renamed => "renamed",
        Delta::Copied => "copied",
        _ => "modified",
    }
}

fn collect_diff_stats(diff: &Diff, workdir: &str) -> HashMap<String, FileDiffStat> {
    let mut stats: HashMap<String, FileDiffStat> = HashMap::new();

    // Use print which gives us delta + line in a single callback
    diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let stat = stats.entry(path.clone()).or_insert_with(|| {
            let abs_path = format!("{}{}", workdir, path);
            FileDiffStat {
                path,
                abs_path,
                additions: 0,
                deletions: 0,
                status: delta_status_str(delta.status()).to_string(),
            }
        });

        match line.origin() {
            '+' => stat.additions += 1,
            '-' => stat.deletions += 1,
            _ => {}
        }
        true
    })
    .ok();

    stats
}

#[tauri::command]
pub fn get_git_diff_stats(cwd: String) -> Result<Vec<FileDiffStat>, String> {
    let repo = match Repository::discover(&cwd) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };

    let workdir = repo
        .workdir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut all_stats: HashMap<String, FileDiffStat> = HashMap::new();

    // Diff HEAD to index (staged changes)
    if let Ok(head) = repo.head() {
        if let Ok(tree) = head.peel_to_tree() {
            if let Ok(diff) = repo.diff_tree_to_index(Some(&tree), None, None) {
                for (path, stat) in collect_diff_stats(&diff, &workdir) {
                    all_stats.insert(path, stat);
                }
            }
        }
    }

    // Diff index to workdir (unstaged changes)
    let mut opts = DiffOptions::new();
    opts.include_untracked(true);
    if let Ok(diff) = repo.diff_index_to_workdir(None, Some(&mut opts)) {
        for (path, stat) in collect_diff_stats(&diff, &workdir) {
            all_stats
                .entry(path)
                .and_modify(|existing| {
                    existing.additions += stat.additions;
                    existing.deletions += stat.deletions;
                })
                .or_insert(stat);
        }
    }

    let mut result: Vec<FileDiffStat> = all_stats.into_values().collect();
    result.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

#[tauri::command]
pub fn get_file_diff(cwd: String, file_path: String) -> Result<Option<FileDiffDetail>, String> {
    let repo = match Repository::discover(&cwd) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };

    let workdir = repo
        .workdir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // Make path relative to repo root
    let rel_path = if file_path.starts_with(&workdir) {
        file_path[workdir.len()..].to_string()
    } else {
        file_path.clone()
    };

    let mut hunks: Vec<DiffHunk> = Vec::new();

    // Collect from both staged and unstaged diffs
    let diffs: Vec<Diff> = {
        let mut v = Vec::new();
        if let Ok(head) = repo.head() {
            if let Ok(tree) = head.peel_to_tree() {
                let mut opts = DiffOptions::new();
                opts.pathspec(&rel_path);
                if let Ok(d) = repo.diff_tree_to_index(Some(&tree), None, Some(&mut opts)) {
                    v.push(d);
                }
            }
        }
        let mut opts = DiffOptions::new();
        opts.pathspec(&rel_path);
        opts.include_untracked(true);
        if let Ok(d) = repo.diff_index_to_workdir(None, Some(&mut opts)) {
            v.push(d);
        }
        v
    };

    for diff in &diffs {
        diff.print(git2::DiffFormat::Patch, |_delta, hunk, line| {
            match line.origin() {
                'H' => {
                    // Hunk header line
                    if let Some(h) = hunk {
                        hunks.push(DiffHunk {
                            old_start: h.old_start(),
                            old_lines: h.old_lines(),
                            new_start: h.new_start(),
                            new_lines: h.new_lines(),
                            lines: Vec::new(),
                        });
                    }
                }
                '+' | '-' | ' ' => {
                    if let Some(current_hunk) = hunks.last_mut() {
                        let kind = match line.origin() {
                            '+' => "add",
                            '-' => "delete",
                            _ => "context",
                        };
                        current_hunk.lines.push(DiffLineInfo {
                            kind: kind.to_string(),
                            content: String::from_utf8_lossy(line.content()).to_string(),
                            new_lineno: line.new_lineno(),
                            old_lineno: line.old_lineno(),
                        });
                    }
                }
                _ => {}
            }
            true
        })
        .ok();
    }

    if hunks.is_empty() {
        return Ok(None);
    }

    Ok(Some(FileDiffDetail {
        path: rel_path,
        hunks,
    }))
}
