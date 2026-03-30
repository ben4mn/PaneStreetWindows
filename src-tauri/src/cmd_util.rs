use std::process::Command;

/// Create a Command that does NOT flash a console window on Windows.
/// On non-Windows platforms, this is just `Command::new(program)`.
pub fn silent_cmd(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
