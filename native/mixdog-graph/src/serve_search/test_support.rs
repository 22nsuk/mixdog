use super::*;

pub(super) fn request(args: &[&str], limit: usize) -> ServeRequest {
    ServeRequest {
        id: 1,
        cwd: ".".to_string(),
        args: args.iter().map(|value| (*value).to_string()).collect(),
        offset: 0,
        limit,
        deadline_ms: None,
        keep_warm: false,
        keep_inventory: false,
        keep_inventory_ms: 0,
        bulk_hint: false,
        mtime_top_k: false,
        fuzzy: None,
        hidden: false,
        include_noise: false,
        max_depth: None,
        exclude: Vec::new(),
    }
}

pub(super) fn with_inventory_aliases(check: impl Fn(&Path, &Path)) {
    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let fixture = std::env::temp_dir().join(format!(
        "mixdog-inventory-alias-{}-{nonce}-{}",
        std::process::id(),
        NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
    ));
    std::fs::create_dir(&fixture).expect("unique fixture");
    let real = fixture.join("real");
    let detour = fixture.join("detour");
    std::fs::create_dir(&real).unwrap();
    std::fs::create_dir(&detour).unwrap();
    check(&real, &detour.join("..").join("real"));

    #[cfg(unix)]
    {
        let real = fixture.join("linked-real");
        let alias = fixture.join("linked-root");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        check(&real, &alias);
    }
    std::fs::remove_dir_all(fixture).expect("remove fixture");
}
