use keyring::Entry;
use serde::Serialize;

const SERVICE: &str = "com.panestreet.app";
const USERNAME: &str = "anthropic-api-key";

#[derive(Clone, Serialize)]
pub struct AuthStatus {
    pub has_key: bool,
    pub key_hint: Option<String>,
}

fn get_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, USERNAME).map_err(|e| format!("Keyring error: {}", e))
}

#[tauri::command]
pub fn save_api_key(key: String) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API key cannot be empty".to_string());
    }

    let entry = get_entry()?;
    entry
        .set_password(trimmed)
        .map_err(|e| format!("Failed to save key: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn get_auth_status() -> Result<AuthStatus, String> {
    let entry = get_entry()?;

    match entry.get_password() {
        Ok(key) => {
            let hint = if key.len() > 8 {
                format!("{}...{}", &key[..7], &key[key.len() - 4..])
            } else {
                "***".to_string()
            };

            Ok(AuthStatus {
                has_key: true,
                key_hint: Some(hint),
            })
        }
        Err(keyring::Error::NoEntry) => Ok(AuthStatus {
            has_key: false,
            key_hint: None,
        }),
        Err(e) => Err(format!("Keyring error: {}", e)),
    }
}

#[tauri::command]
pub fn delete_api_key() -> Result<(), String> {
    let entry = get_entry()?;

    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already gone
        Err(e) => Err(format!("Failed to delete key: {}", e)),
    }
}
