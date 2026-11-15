//! Fixed publisher channel and bounded, metadata-only native update policy.
use serde::Deserialize;
use serde_json::Value;
use url::Url;

pub const ENDPOINT: &str = "https://github.com/jupes/agent-forge-harness/releases/latest/download/latest.json";
pub const TARGET: &str = "windows-x86_64-nsis";
pub const METADATA_LIMIT: usize = 64 * 1024;
pub const PACKAGE_LIMIT: usize = 256 * 1024 * 1024;
pub const TTL_MS: u64 = 15 * 60 * 1000;

pub fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

pub fn publisher_transport(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
        && match url.host_str() {
            Some("github.com") => url.path().starts_with("/jupes/agent-forge-harness/releases/"),
            Some("release-assets.githubusercontent.com") => true,
            _ => false,
        }
}

pub fn package_url(raw: &str, version: &str) -> Result<Url, ()> {
    let url = Url::parse(raw).map_err(|_| ())?;
    let prefix = format!("/jupes/agent-forge-harness/releases/download/v{version}/");
    let file = url.path().strip_prefix(&prefix).ok_or(())?;
    if !publisher_transport(&url)
        || url.host_str() != Some("github.com")
        || url.as_str() != raw
        || url.query().is_some()
        || file.is_empty()
        || file.len() > 240
        || file.contains('/')
        || file.to_ascii_lowercase().contains("%2f")
        || file.to_ascii_lowercase().contains("%5c")
        || !file.ends_with("_x64-setup.exe")
    {
        return Err(());
    }
    Ok(url)
}

pub fn stable_manifest(bytes: &[u8]) -> Result<(Value, String), ()> {
    if bytes.is_empty() || bytes.len() > METADATA_LIMIT {
        return Err(());
    }
    let raw: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
    let version = raw.get("version").and_then(Value::as_str).ok_or(())?;
    let parsed = semver::Version::parse(version).map_err(|_| ())?;
    if version.len() > 100 || !parsed.pre.is_empty() || !parsed.build.is_empty() {
        return Err(());
    }
    let target = raw.get("platforms").and_then(|p| p.get(TARGET)).ok_or(())?;
    let signature = target.get("signature").and_then(Value::as_str).ok_or(())?;
    if signature.is_empty() || signature.len() > 4096 {
        return Err(());
    }
    package_url(target.get("url").and_then(Value::as_str).ok_or(())?, version)?;
    let version = version.to_owned();
    Ok((raw, version))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authorization {
    schema_version: u8,
    operation: String,
    request_id: String,
    root: String,
    home: String,
    audit_event_id: u64,
    created_at: u64,
}

pub fn authorize(
    bytes: &[u8],
    operation: &str,
    id: &str,
    root: &str,
    home: &str,
    prepared_at: u64,
    now: u64,
) -> Result<(), ()> {
    if bytes.len() > 8192 || !valid_id(id) {
        return Err(());
    }
    let value: Authorization = serde_json::from_slice(bytes).map_err(|_| ())?;
    if value.schema_version != 1
        || value.operation != operation
        || value.request_id != id
        || value.root != root
        || value.home != home
        || value.audit_event_id == 0
        || value.audit_event_id > 9_007_199_254_740_991
        || value.created_at < prepared_at
        || value.created_at > now
        || now - value.created_at >= TTL_MS
    {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_official_https_publisher_can_redirect_or_supply_a_version_bound_installer() {
        let good = "https://github.com/jupes/agent-forge-harness/releases/download/v1.0.0/Agent%20Forge%20Harness_1.0.0_x64-setup.exe";
        assert!(package_url(good, "1.0.0").is_ok());
        for bad in [
            good.replace("https:", "http:"),
            good.replace("github.com", "github.com.foreign.example"),
            good.replace("/jupes/", "/foreign/"),
            good.replace("/v1.0.0/", "/v0.9.0/"),
            good.replace("_x64-setup.exe", "_arm64-setup.exe"),
            format!("{good}?other=1"),
            format!("{good}#other"),
        ] {
            assert!(package_url(&bad, "1.0.0").is_err());
        }
        assert!(publisher_transport(&Url::parse("https://release-assets.githubusercontent.com/release-asset?signature=opaque").unwrap()));
        assert!(!publisher_transport(&Url::parse("https://github.com/foreign/repo/releases/latest").unwrap()));
    }

    #[test]
    fn missing_wrong_platform_prerelease_and_oversized_metadata_refuse() {
        let raw = json!({"version":"1.0.0","platforms":{"windows-x86_64-nsis":{"url":"https://github.com/jupes/agent-forge-harness/releases/download/v1.0.0/Forge_1.0.0_x64-setup.exe","signature":"fixture"}}});
        assert!(stable_manifest(&serde_json::to_vec(&raw).unwrap()).is_ok());
        for version in ["1.0.0-rc.1", "1.0.0+other", "v1.0.0", "other"] {
            let mut bad = raw.clone();
            bad["version"] = json!(version);
            assert!(stable_manifest(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
        assert!(stable_manifest(&vec![b' '; METADATA_LIMIT + 1]).is_err());
        assert!(stable_manifest(br#"{"version":"1.0.0","platforms":{}}"#).is_err());
    }

    #[test]
    fn operator_authorization_is_exact_scoped_fresh_and_metadata_only() {
        let id = "ad000000-0000-4000-8000-000000000001";
        let raw = json!({"schemaVersion":1,"operation":"install","requestId":id,"root":"root","home":"home","auditEventId":42,"createdAt":1000});
        let bytes = serde_json::to_vec(&raw).unwrap();
        assert!(authorize(&bytes, "install", id, "root", "home", 900, 1001).is_ok());
        for (operation, root, home, prepared, now) in [
            ("download", "root", "home", 900, 1001),
            ("install", "other", "home", 900, 1001),
            ("install", "root", "other", 900, 1001),
            ("install", "root", "home", 1001, 1001),
            ("install", "root", "home", 900, 999),
            ("install", "root", "home", 900, 1000 + TTL_MS),
        ] {
            assert!(authorize(&bytes, operation, id, root, home, prepared, now).is_err());
        }
        assert!(!valid_id("../../foreign"));
        let mut unaudited = raw;
        unaudited["auditEventId"] = json!(0);
        assert!(authorize(&serde_json::to_vec(&unaudited).unwrap(), "install", id, "root", "home", 900, 1001).is_err());
    }
}
