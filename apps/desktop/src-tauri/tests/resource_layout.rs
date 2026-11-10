use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::utils::resources::ResourcePaths;

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let target = self
            .0
            .canonicalize()
            .expect("resolve owned resource fixture");
        let parent = std::env::temp_dir()
            .canonicalize()
            .expect("resolve temp parent");
        assert!(target.is_absolute());
        assert_eq!(target.parent(), Some(parent.as_path()));
        assert_eq!(target.file_name(), self.0.file_name());
        fs::remove_dir_all(target).expect("remove owned resource fixture");
    }
}

#[test]
fn installed_dashboard_preserves_nested_paths_and_bytes() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let resources = config["bundle"]["resources"].as_object().unwrap();
    assert_eq!(resources.len(), 1);
    let (pattern, destination) = resources.iter().next().unwrap();
    let suffix = pattern.strip_prefix("../../../docs/dist").unwrap();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "agent-forge-resource-layout-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&root).expect("exclusively create resource fixture");
    let fixture = Fixture(root);
    let paths = [
        "assets/index.js",
        "assets/nested/index.js",
        ".claude/skills/ATTRIBUTION.md",
        "docs/fonts/LICENSE-Inter.txt",
        "index.html",
        "LICENSE",
    ];
    for path in paths {
        let file = fixture.0.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, path.as_bytes()).unwrap();
    }
    let mapping = HashMap::from([(
        format!("{}{suffix}", fixture.0.to_string_lossy().replace('\\', "/")),
        destination.as_str().unwrap().to_owned(),
    )]);
    let mut actual = ResourcePaths::from_map(&mapping, true)
        .iter()
        .map(|resource| {
            let resource = resource.unwrap();
            (
                resource.target().to_string_lossy().replace('\\', "/"),
                fs::read(resource.path()).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    actual.sort();
    let mut expected = paths
        .map(|path| (format!("dashboard/{path}"), path.as_bytes().to_vec()))
        .to_vec();
    expected.sort();
    assert_eq!(actual, expected);
}
