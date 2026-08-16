export const migrations = [
  {
    version: 1,
    name: "initial_library",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS library_roots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host_path_hint TEXT,
        container_path TEXT NOT NULL UNIQUE,
        policy TEXT NOT NULL CHECK(policy IN ('WATCH_ONLY', 'MANAGED')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scan_jobs (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED')),
        total_files INTEGER NOT NULL DEFAULT 0,
        processed_files INTEGER NOT NULL DEFAULT 0,
        parsed_files INTEGER NOT NULL DEFAULT 0,
        failed_files INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS scan_jobs_status_created_idx ON scan_jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS scan_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        code TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        recoverable INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scan_failures_job_idx ON scan_failures(scan_job_id, id);

      CREATE TABLE IF NOT EXISTS worker_heartbeats (
        role TEXT PRIMARY KEY,
        process_id INTEGER NOT NULL,
        state TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS media_files (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        absolute_path TEXT NOT NULL,
        extension TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        modified_at_ms REAL NOT NULL,
        container TEXT,
        codec TEXT,
        audio_kind TEXT NOT NULL,
        lossless INTEGER,
        bit_depth INTEGER,
        sample_rate INTEGER,
        bitrate INTEGER,
        channels INTEGER,
        dsd_rate TEXT,
        duration_seconds REAL,
        album TEXT,
        album_artist TEXT,
        title TEXT,
        artists_json TEXT NOT NULL DEFAULT '[]',
        year INTEGER,
        date_text TEXT,
        genre_json TEXT NOT NULL DEFAULT '[]',
        composer_json TEXT NOT NULL DEFAULT '[]',
        label_json TEXT NOT NULL DEFAULT '[]',
        catalog_number TEXT,
        barcode TEXT,
        musicbrainz_release_id TEXT,
        disc_number INTEGER,
        disc_total INTEGER,
        track_number INTEGER,
        track_total INTEGER,
        artwork_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        scan_job_id TEXT REFERENCES scan_jobs(id) ON DELETE SET NULL,
        scanned_at TEXT NOT NULL,
        UNIQUE(root_id, relative_path)
      );

      CREATE INDEX IF NOT EXISTS media_files_root_album_idx ON media_files(root_id, album_artist, album);
      CREATE INDEX IF NOT EXISTS media_files_root_path_idx ON media_files(root_id, relative_path);

      CREATE TABLE IF NOT EXISTS albums (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        group_key TEXT NOT NULL,
        title TEXT NOT NULL,
        album_artist TEXT NOT NULL,
        year INTEGER,
        disc_count INTEGER NOT NULL DEFAULT 1,
        track_count INTEGER NOT NULL DEFAULT 0,
        audio_summary_json TEXT,
        audio_badge TEXT,
        mixed_audio_specs INTEGER NOT NULL DEFAULT 0,
        artwork_json TEXT NOT NULL,
        match_status TEXT NOT NULL DEFAULT 'UNMATCHED',
        label TEXT,
        catalog_number TEXT,
        barcode TEXT,
        country TEXT,
        release_date TEXT,
        musicbrainz_release_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(root_id, group_key)
      );

      CREATE INDEX IF NOT EXISTS albums_title_artist_idx ON albums(title, album_artist);

      CREATE TABLE IF NOT EXISTS album_files (
        album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
        media_file_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
        PRIMARY KEY(album_id, media_file_id)
      );

      CREATE TABLE IF NOT EXISTS physical_copies (
        id TEXT PRIMARY KEY,
        album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
        medium TEXT NOT NULL CHECK(medium IN ('CD', 'SACD', 'VINYL', 'CASSETTE', 'BLURAY_AUDIO', 'OTHER')),
        label TEXT,
        catalog_number TEXT,
        barcode TEXT,
        country TEXT,
        release_year INTEGER,
        quantity INTEGER NOT NULL DEFAULT 1,
        condition_note TEXT,
        storage_location TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS physical_copies_album_idx ON physical_copies(album_id);

      CREATE TABLE IF NOT EXISTS delivery_records (
        id TEXT PRIMARY KEY,
        album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
        target_name TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('MOUNTED_VOLUME', 'NETWORK')),
        delivered_at TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS owned_devices (
        id TEXT PRIMARY KEY,
        manufacturer TEXT NOT NULL,
        model TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('DAP','DAC','AMPLIFIER','HEADPHONE','SPEAKER','STREAMER','OTHER')),
        ownership TEXT NOT NULL CHECK(ownership IN ('OWNED','BORROWED','SOLD','WISHLIST')),
        nickname TEXT,
        serial_number TEXT,
        notes TEXT,
        capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS delivery_targets (
        id TEXT PRIMARY KEY,
        device_id TEXT REFERENCES owned_devices(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('MOUNTED_VOLUME','NETWORK')),
        transport TEXT NOT NULL CHECK(transport IN ('USB_MOUNT','SMB','SFTP','FTP','AK_FILE_DROP','OTHER')),
        location TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS delivery_targets_device_idx ON delivery_targets(device_id);
    `,
  },
  {
    version: 2,
    name: "scan_audit_and_gear_collection",
    sql: `
      CREATE TABLE IF NOT EXISTS scan_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        code TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        recoverable INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scan_failures_job_idx ON scan_failures(scan_job_id, id);

      CREATE TABLE IF NOT EXISTS worker_heartbeats (
        role TEXT PRIMARY KEY,
        process_id INTEGER NOT NULL,
        state TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS owned_devices (
        id TEXT PRIMARY KEY,
        manufacturer TEXT NOT NULL,
        model TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('DAP','DAC','AMPLIFIER','HEADPHONE','SPEAKER','STREAMER','OTHER')),
        ownership TEXT NOT NULL CHECK(ownership IN ('OWNED','BORROWED','SOLD','WISHLIST')),
        nickname TEXT,
        serial_number TEXT,
        notes TEXT,
        capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS delivery_targets (
        id TEXT PRIMARY KEY,
        device_id TEXT REFERENCES owned_devices(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('MOUNTED_VOLUME','NETWORK')),
        transport TEXT NOT NULL CHECK(transport IN ('USB_MOUNT','SMB','SFTP','FTP','AK_FILE_DROP','OTHER')),
        location TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delivery_targets_device_idx ON delivery_targets(device_id);
    `,
  },
  {
    version: 3,
    name: "release_match_candidates",
    sql: `
      CREATE TABLE IF NOT EXISTS release_match_candidates (
        id TEXT PRIMARY KEY,
        album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK(source IN ('MUSICBRAINZ')),
        source_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(album_id, source, source_id)
      );

      CREATE INDEX IF NOT EXISTS release_match_candidates_album_idx
        ON release_match_candidates(album_id, source, fetched_at DESC);
    `,
  },
  {
    version: 4,
    name: "versioned_still_catalog",
    sql: `
      CREATE TABLE IF NOT EXISTS still_catalog_versions (
        content_version TEXT PRIMARY KEY,
        source_schema_id TEXT NOT NULL,
        source_schema_version TEXT NOT NULL,
        source_content_checksum TEXT NOT NULL,
        runtime_checksum TEXT NOT NULL UNIQUE,
        record_count INTEGER NOT NULL,
        rejected_record_count INTEGER NOT NULL,
        installed_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS still_catalog_single_active_idx
        ON still_catalog_versions(active) WHERE active = 1;

      CREATE TABLE IF NOT EXISTS still_catalog_albums (
        content_version TEXT NOT NULL REFERENCES still_catalog_versions(content_version) ON DELETE CASCADE,
        still_album_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        recording_family_id TEXT,
        release_family_id TEXT,
        domains_json TEXT NOT NULL,
        features_json TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        PRIMARY KEY(content_version, still_album_id)
      );

      CREATE INDEX IF NOT EXISTS still_catalog_albums_identity_idx
        ON still_catalog_albums(title COLLATE NOCASE, artist COLLATE NOCASE);
    `,
  },
  {
    version: 5,
    name: "physical_collection_root",
    sql: `
      ALTER TABLE library_roots ADD COLUMN system INTEGER NOT NULL DEFAULT 0 CHECK(system IN (0, 1));

      INSERT OR IGNORE INTO library_roots
        (id, name, host_path_hint, container_path, policy, enabled, created_at, updated_at, system)
      VALUES
        ('physical', '实体收藏', NULL, 'cocean://physical-collection', 'MANAGED', 1,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1);
    `,
  },
  {
    version: 6,
    name: "immutable_scan_evidence",
    sql: `
      ALTER TABLE albums ADD COLUMN aggregation_issues_json TEXT NOT NULL DEFAULT '[]';

      CREATE TABLE scan_file_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        extension TEXT NOT NULL,
        candidate_kind TEXT NOT NULL CHECK(candidate_kind IN (
          'SUPPORTED_AUDIO', 'KNOWN_UNSUPPORTED_AUDIO', 'SYMLINK', 'TRAVERSAL_ERROR'
        )),
        outcome TEXT NOT NULL CHECK(outcome IN ('PARSED', 'UNSUPPORTED', 'FAILED', 'SKIPPED')),
        media_file_id TEXT,
        size_bytes INTEGER,
        modified_at_ms REAL,
        error_code TEXT,
        error_stage TEXT,
        warning_codes_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(scan_job_id, candidate_kind, relative_path),
        CHECK(size_bytes IS NULL OR size_bytes >= 0),
        CHECK(modified_at_ms IS NULL OR modified_at_ms >= 0),
        CHECK((outcome = 'PARSED' AND media_file_id IS NOT NULL AND error_code IS NULL)
          OR outcome <> 'PARSED'),
        CHECK(
          (candidate_kind = 'SUPPORTED_AUDIO' AND outcome IN ('PARSED','UNSUPPORTED','FAILED'))
          OR (candidate_kind = 'KNOWN_UNSUPPORTED_AUDIO' AND outcome = 'UNSUPPORTED')
          OR (candidate_kind = 'SYMLINK' AND outcome = 'SKIPPED')
          OR (candidate_kind = 'TRAVERSAL_ERROR' AND outcome = 'FAILED')
        )
      );

      CREATE INDEX scan_file_results_job_id_idx
        ON scan_file_results(scan_job_id, id);
      CREATE INDEX scan_file_results_job_outcome_idx
        ON scan_file_results(scan_job_id, outcome, id);

      CREATE TRIGGER scan_file_results_immutable_update
      BEFORE UPDATE ON scan_file_results
      BEGIN
        SELECT RAISE(ABORT, 'scan_file_results are immutable');
      END;

      CREATE TABLE scan_discovery_state (
        scan_job_id TEXT PRIMARY KEY REFERENCES scan_jobs(id) ON DELETE CASCADE,
        rules_version TEXT NOT NULL,
        candidates INTEGER NOT NULL,
        regular_files INTEGER NOT NULL,
        auxiliary_files INTEGER NOT NULL,
        ignored_files INTEGER NOT NULL,
        skipped_symlinks INTEGER NOT NULL,
        traversal_errors INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        CHECK(candidates >= 0 AND regular_files >= 0 AND auxiliary_files >= 0
          AND ignored_files >= 0 AND skipped_symlinks >= 0 AND traversal_errors >= 0),
        CHECK(regular_files = candidates + auxiliary_files + ignored_files)
      );

      CREATE TRIGGER scan_discovery_state_immutable_update
      BEFORE UPDATE ON scan_discovery_state
      BEGIN
        SELECT RAISE(ABORT, 'scan_discovery_state is immutable');
      END;

      CREATE TABLE scan_reports (
        scan_job_id TEXT PRIMARY KEY REFERENCES scan_jobs(id) ON DELETE CASCADE,
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        rules_version TEXT NOT NULL,
        summary_hash TEXT NOT NULL,
        candidates INTEGER NOT NULL,
        processed INTEGER NOT NULL,
        parsed INTEGER NOT NULL,
        unsupported INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        unprocessed INTEGER NOT NULL,
        regular_files INTEGER NOT NULL,
        auxiliary_files INTEGER NOT NULL,
        ignored_files INTEGER NOT NULL,
        skipped_symlinks INTEGER NOT NULL,
        traversal_errors INTEGER NOT NULL,
        boundary_evidence INTEGER NOT NULL CHECK(boundary_evidence IN (0, 1)),
        album_count INTEGER,
        album_issue_count INTEGER,
        created_at TEXT NOT NULL,
        CHECK(length(summary_hash) = 64),
        CHECK(candidates >= 0 AND processed >= 0 AND parsed >= 0
          AND unsupported >= 0 AND failed >= 0 AND unprocessed >= 0),
        CHECK(regular_files >= 0 AND auxiliary_files >= 0 AND ignored_files >= 0
          AND skipped_symlinks >= 0 AND traversal_errors >= 0),
        CHECK(candidates = processed + unprocessed),
        CHECK(processed = parsed + unsupported + failed),
        CHECK(regular_files = candidates + auxiliary_files + ignored_files),
        CHECK(album_count IS NULL OR album_count >= 0),
        CHECK(album_issue_count IS NULL OR album_issue_count >= 0)
      );

      CREATE TRIGGER scan_reports_immutable_update
      BEFORE UPDATE ON scan_reports
      BEGIN
        SELECT RAISE(ABORT, 'scan_reports are immutable');
      END;

      CREATE TRIGGER scan_jobs_frozen_after_report
      BEFORE UPDATE ON scan_jobs
      WHEN EXISTS (
        SELECT 1 FROM scan_reports WHERE scan_reports.scan_job_id = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'scan job is frozen by its immutable report');
      END;
    `,
  },
  {
    version: 7,
    name: "file_checksums_and_native_tags",
    sql: `
      ALTER TABLE media_files ADD COLUMN file_sha256 TEXT;
      ALTER TABLE media_files ADD COLUMN raw_tags_json TEXT NOT NULL DEFAULT '[]';

      CREATE INDEX media_files_sha256_idx
        ON media_files(file_sha256) WHERE file_sha256 IS NOT NULL;
    `,
  },
  {
    version: 8,
    name: "freeze_scan_ledger_and_album_ownership",
    sql: `
      CREATE UNIQUE INDEX album_files_one_album_per_media_idx
        ON album_files(media_file_id);

      CREATE TRIGGER scan_file_results_no_late_insert
      BEFORE INSERT ON scan_file_results
      WHEN EXISTS (
        SELECT 1 FROM scan_reports WHERE scan_reports.scan_job_id = NEW.scan_job_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'scan_file_results are frozen by their immutable report');
      END;

      CREATE TRIGGER scan_file_results_immutable_delete
      BEFORE DELETE ON scan_file_results
      BEGIN
        SELECT RAISE(ABORT, 'scan_file_results are immutable');
      END;

      CREATE TRIGGER scan_discovery_state_immutable_delete
      BEFORE DELETE ON scan_discovery_state
      BEGIN
        SELECT RAISE(ABORT, 'scan_discovery_state is immutable');
      END;

      CREATE TRIGGER scan_reports_immutable_delete
      BEFORE DELETE ON scan_reports
      BEGIN
        SELECT RAISE(ABORT, 'scan_reports are immutable');
      END;

      CREATE TRIGGER scan_failures_immutable_update
      BEFORE UPDATE ON scan_failures
      BEGIN
        SELECT RAISE(ABORT, 'scan_failures are immutable');
      END;

      CREATE TRIGGER scan_failures_immutable_delete
      BEFORE DELETE ON scan_failures
      BEGIN
        SELECT RAISE(ABORT, 'scan_failures are immutable');
      END;

      CREATE TRIGGER scan_failures_no_late_insert
      BEFORE INSERT ON scan_failures
      WHEN EXISTS (
        SELECT 1 FROM scan_reports WHERE scan_reports.scan_job_id = NEW.scan_job_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'scan_failures are frozen by their immutable report');
      END;

      CREATE TRIGGER scan_jobs_immutable_delete
      BEFORE DELETE ON scan_jobs
      WHEN EXISTS (
        SELECT 1 FROM scan_reports WHERE scan_reports.scan_job_id = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'scan job is frozen by its immutable report');
      END;
    `,
  },
  {
    version: 9,
    name: "accounts_incremental_delivery_and_assistant",
    sql: `
      ALTER TABLE scan_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'FULL'
        CHECK(mode IN ('INCREMENTAL','FULL'));
      ALTER TABLE scan_jobs ADD COLUMN reused_files INTEGER NOT NULL DEFAULT 0
        CHECK(reused_files >= 0);
      ALTER TABLE scan_jobs ADD COLUMN cancel_requested_at TEXT;

      ALTER TABLE delivery_targets ADD COLUMN username TEXT;
      ALTER TABLE delivery_targets ADD COLUMN credential_json TEXT;

      CREATE TABLE app_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('ADMIN','MEMBER')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE app_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX app_sessions_user_idx ON app_sessions(user_id, expires_at);
      CREATE INDEX app_sessions_expiry_idx ON app_sessions(expires_at);

      CREATE TABLE delivery_jobs (
        id TEXT PRIMARY KEY,
        album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES delivery_targets(id) ON DELETE RESTRICT,
        target_name TEXT NOT NULL,
        transport TEXT NOT NULL CHECK(transport IN ('USB_MOUNT','SMB','SFTP','FTP','AK_FILE_DROP','OTHER')),
        status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
        file_count INTEGER NOT NULL DEFAULT 0 CHECK(file_count >= 0),
        total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes >= 0),
        transferred_bytes INTEGER NOT NULL DEFAULT 0 CHECK(transferred_bytes >= 0),
        manifest_json TEXT NOT NULL DEFAULT '[]',
        verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX delivery_jobs_album_idx ON delivery_jobs(album_id, created_at DESC);
      CREATE INDEX delivery_jobs_status_idx ON delivery_jobs(status, created_at);

      CREATE TABLE model_configuration (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        credential_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE album_introductions (
        album_id TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        model TEXT NOT NULL,
        factual_basis_json TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 10,
    name: "normalize_legacy_ak_file_drop_targets",
    sql: `
      UPDATE delivery_targets
      SET transport = 'AK_FILE_DROP',
          kind = 'NETWORK',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE lower(location) LIKE 'ftp://%'
        AND transport IN ('SMB', 'SFTP', 'FTP', 'OTHER');
    `,
  },
  {
    version: 11,
    name: "album_source_versions_and_delivery_progress",
    sql: `
      ALTER TABLE albums ADD COLUMN source_version_count INTEGER NOT NULL DEFAULT 1
        CHECK(source_version_count > 0);
      ALTER TABLE albums ADD COLUMN duplicate_file_count INTEGER NOT NULL DEFAULT 0
        CHECK(duplicate_file_count >= 0);
      ALTER TABLE album_files ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 1
        CHECK(is_primary IN (0,1));
      ALTER TABLE album_files ADD COLUMN disc_number_override INTEGER
        CHECK(disc_number_override IS NULL OR disc_number_override > 0);
      CREATE INDEX album_files_primary_album_idx
        ON album_files(album_id, is_primary, disc_number_override);

      UPDATE delivery_targets
      SET verified_at = (
        SELECT MAX(delivery_jobs.finished_at)
        FROM delivery_jobs
        WHERE delivery_jobs.target_id = delivery_targets.id
          AND delivery_jobs.status = 'COMPLETED'
          AND delivery_jobs.verified = 1
      ),
      updated_at = COALESCE((
        SELECT MAX(delivery_jobs.finished_at)
        FROM delivery_jobs
        WHERE delivery_jobs.target_id = delivery_targets.id
          AND delivery_jobs.status = 'COMPLETED'
          AND delivery_jobs.verified = 1
      ), updated_at)
      WHERE verified_at IS NULL
        AND EXISTS (
          SELECT 1 FROM delivery_jobs
          WHERE delivery_jobs.target_id = delivery_targets.id
            AND delivery_jobs.status = 'COMPLETED'
            AND delivery_jobs.verified = 1
        );

      UPDATE delivery_jobs
      SET error = '旧版任务调度误判为服务重启；该问题已修复，可忽略此条历史失败'
      WHERE status = 'FAILED'
        AND error = '服务重启中断了投送；请重新发起';
    `,
  },
  {
    version: 12,
    name: "model_connection_verification",
    sql: `
      ALTER TABLE model_configuration ADD COLUMN verification_status TEXT NOT NULL
        DEFAULT 'UNVERIFIED'
        CHECK(verification_status IN ('UNVERIFIED','VERIFIED','FAILED'));
      ALTER TABLE model_configuration ADD COLUMN last_checked_at TEXT;
      ALTER TABLE model_configuration ADD COLUMN verification_message TEXT;
    `,
  },
  {
    version: 13,
    name: "delivery_plans",
    sql: `
      ALTER TABLE delivery_jobs ADD COLUMN plan_id TEXT;
      CREATE INDEX delivery_jobs_plan_idx
        ON delivery_jobs(plan_id, created_at) WHERE plan_id IS NOT NULL;
    `,
  },
  {
    version: 14,
    name: "immutable_delivery_sources_and_active_deduplication",
    sql: `
      ALTER TABLE delivery_jobs ADD COLUMN source_bundle_json TEXT;
      CREATE INDEX delivery_jobs_target_plan_idx
        ON delivery_jobs(target_id, plan_id, created_at)
        WHERE plan_id IS NOT NULL;

      CREATE TRIGGER delivery_jobs_no_duplicate_active_insert
      BEFORE INSERT ON delivery_jobs
      WHEN NEW.status IN ('QUEUED','RUNNING')
        AND EXISTS (
          SELECT 1 FROM delivery_jobs
          WHERE album_id = NEW.album_id
            AND target_id = NEW.target_id
            AND status IN ('QUEUED','RUNNING')
        )
      BEGIN
        SELECT RAISE(ABORT, 'active delivery already exists for album and target');
      END;

      CREATE TRIGGER delivery_jobs_no_duplicate_active_update
      BEFORE UPDATE OF status, album_id, target_id ON delivery_jobs
      WHEN NEW.status IN ('QUEUED','RUNNING')
        AND EXISTS (
          SELECT 1 FROM delivery_jobs
          WHERE id <> NEW.id
            AND album_id = NEW.album_id
            AND target_id = NEW.target_id
            AND status IN ('QUEUED','RUNNING')
        )
      BEGIN
        SELECT RAISE(ABORT, 'active delivery already exists for album and target');
      END;
    `,
  },
  {
    version: 15,
    name: "auto_discovery",
    sql: `
      ALTER TABLE library_roots ADD COLUMN auto_discovery_enabled INTEGER NOT NULL
        DEFAULT 0 CHECK(auto_discovery_enabled IN (0,1));
      ALTER TABLE library_roots ADD COLUMN auto_discovery_interval_minutes INTEGER NOT NULL
        DEFAULT 5 CHECK(auto_discovery_interval_minutes BETWEEN 1 AND 1440);
      ALTER TABLE library_roots ADD COLUMN next_auto_scan_at TEXT;
      ALTER TABLE library_roots ADD COLUMN auto_discovery_probe_for_scan_at TEXT;

      ALTER TABLE scan_jobs ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'MANUAL'
        CHECK(trigger_source IN ('MANUAL','AUTO_DISCOVERY','RETRY'));
      ALTER TABLE scan_jobs ADD COLUMN retry_of_scan_job_id TEXT
        REFERENCES scan_jobs(id) ON DELETE SET NULL;
      ALTER TABLE scan_jobs ADD COLUMN stable_album_directories INTEGER NOT NULL
        DEFAULT 0 CHECK(stable_album_directories >= 0);
      ALTER TABLE scan_jobs ADD COLUMN deferred_album_directories INTEGER NOT NULL
        DEFAULT 0 CHECK(deferred_album_directories >= 0);

      UPDATE scan_jobs
      SET status='CANCELLED',
          finished_at=COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          error=COALESCE(error, '升级时检测到同根目录重复活跃扫描；已确定性保留一条任务')
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY root_id
              ORDER BY CASE status WHEN 'RUNNING' THEN 0 ELSE 1 END,
                       created_at, id
            ) AS active_order
          FROM scan_jobs
          WHERE status IN ('QUEUED','RUNNING')
        ) WHERE active_order > 1
      );

      CREATE UNIQUE INDEX scan_jobs_one_active_per_root_idx
        ON scan_jobs(root_id) WHERE status IN ('QUEUED','RUNNING');
      CREATE INDEX scan_jobs_trigger_source_idx
        ON scan_jobs(trigger_source, created_at DESC);

      CREATE TABLE album_stability_observations (
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        relative_directory TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        PRIMARY KEY(root_id, relative_directory)
      );
      CREATE INDEX album_stability_last_seen_idx
        ON album_stability_observations(root_id, last_observed_at);
    `,
  },
  {
    version: 16,
    name: "library_album_identity_and_integrity",
    sql: `
      CREATE TABLE library_albums (
        id TEXT PRIMARY KEY,
        identity_key TEXT NOT NULL,
        title TEXT NOT NULL,
        album_artist TEXT NOT NULL,
        primary_version_id TEXT REFERENCES albums(id) ON DELETE SET NULL,
        decision_source TEXT NOT NULL DEFAULT 'AUTOMATIC'
          CHECK(decision_source IN ('AUTOMATIC','USER')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX library_albums_automatic_identity_idx
        ON library_albums(identity_key) WHERE decision_source='AUTOMATIC';

      CREATE TABLE library_album_members (
        library_album_id TEXT NOT NULL REFERENCES library_albums(id) ON DELETE CASCADE,
        album_id TEXT NOT NULL UNIQUE REFERENCES albums(id) ON DELETE CASCADE,
        relationship_status TEXT NOT NULL DEFAULT 'AUTO_CANDIDATE'
          CHECK(relationship_status IN ('AUTO_CANDIDATE','USER_CONFIRMED','USER_SEPARATE')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(library_album_id, album_id)
      );
      CREATE INDEX library_album_members_library_idx
        ON library_album_members(library_album_id, album_id);

      CREATE TABLE library_issues (
        library_album_id TEXT NOT NULL REFERENCES library_albums(id) ON DELETE CASCADE,
        album_id TEXT REFERENCES albums(id) ON DELETE CASCADE,
        code TEXT NOT NULL CHECK(code IN (
          'IDENTITY_OVERLAP','INCOMPLETE_TRACKS','MISSING_ARTWORK',
          'LOW_RES_ARTWORK','MIXED_AUDIO_SPECS','BROKEN_TEXT','MISSING_IDENTITY'
        )),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(library_album_id, code, album_id)
      );
      CREATE INDEX library_issues_code_idx
        ON library_issues(code, library_album_id);
      CREATE UNIQUE INDEX library_issues_identity_idx
        ON library_issues(library_album_id, code, COALESCE(album_id, char(0)));
    `,
  },
  {
    version: 17,
    name: "manual_library_album_identity_governance",
    sql: `
      ALTER TABLE library_albums ADD COLUMN primary_version_source TEXT NOT NULL DEFAULT 'AUTOMATIC'
        CHECK(primary_version_source IN ('AUTOMATIC','USER'));
      ALTER TABLE library_albums ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
        CHECK(revision >= 0);

      CREATE TABLE library_album_aliases (
        alias_id TEXT PRIMARY KEY,
        library_album_id TEXT NOT NULL REFERENCES library_albums(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        CHECK(alias_id <> library_album_id)
      );
      CREATE INDEX library_album_aliases_target_idx
        ON library_album_aliases(library_album_id, alias_id);

      CREATE TABLE library_identity_decisions (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        library_album_id TEXT NOT NULL,
        decision_type TEXT NOT NULL CHECK(decision_type IN (
          'CONFIRM','MERGE','SPLIT','SET_PRIMARY','UNDO'
        )),
        actor_id TEXT NOT NULL,
        actor_display_name TEXT NOT NULL,
        expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
        resulting_revision INTEGER NOT NULL CHECK(resulting_revision >= 0),
        input_json TEXT NOT NULL,
        details_json TEXT NOT NULL,
        before_state_json TEXT NOT NULL,
        after_state_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        compensates_decision_id TEXT REFERENCES library_identity_decisions(id),
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX library_identity_decisions_compensation_idx
        ON library_identity_decisions(compensates_decision_id)
        WHERE compensates_decision_id IS NOT NULL;
      CREATE INDEX library_identity_decisions_album_created_idx
        ON library_identity_decisions(library_album_id, created_at DESC, id DESC);

      CREATE TABLE library_identity_decision_groups (
        decision_id TEXT NOT NULL REFERENCES library_identity_decisions(id),
        library_album_id TEXT NOT NULL,
        association_kind TEXT NOT NULL DEFAULT 'AFFECTED'
          CHECK(association_kind IN ('AFFECTED','HISTORY')),
        PRIMARY KEY(decision_id, library_album_id)
      );
      CREATE INDEX library_identity_decision_groups_album_idx
        ON library_identity_decision_groups(library_album_id, decision_id);

      CREATE TRIGGER library_identity_decisions_no_update
        BEFORE UPDATE ON library_identity_decisions
        BEGIN SELECT RAISE(ABORT, 'library identity decision ledger is append-only'); END;
      CREATE TRIGGER library_identity_decisions_no_delete
        BEFORE DELETE ON library_identity_decisions
        BEGIN SELECT RAISE(ABORT, 'library identity decision ledger is append-only'); END;
      CREATE TRIGGER library_identity_decision_groups_no_update
        BEFORE UPDATE ON library_identity_decision_groups
        BEGIN SELECT RAISE(ABORT, 'library identity decision group ledger is append-only'); END;
      CREATE TRIGGER library_identity_decision_groups_no_delete
        BEFORE DELETE ON library_identity_decision_groups
        BEGIN SELECT RAISE(ABORT, 'library identity decision group ledger is append-only'); END;

      CREATE TRIGGER library_album_aliases_current_id_conflict_insert
        BEFORE INSERT ON library_album_aliases
        WHEN EXISTS (SELECT 1 FROM library_albums WHERE id=NEW.alias_id)
        BEGIN SELECT RAISE(ABORT, 'library album alias conflicts with a current id'); END;
      CREATE TRIGGER library_album_aliases_current_id_conflict_update
        BEFORE UPDATE OF alias_id ON library_album_aliases
        WHEN EXISTS (SELECT 1 FROM library_albums WHERE id=NEW.alias_id)
        BEGIN SELECT RAISE(ABORT, 'library album alias conflicts with a current id'); END;
      CREATE TRIGGER library_albums_alias_id_conflict_insert
        BEFORE INSERT ON library_albums
        WHEN EXISTS (SELECT 1 FROM library_album_aliases WHERE alias_id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'library album current id conflicts with an alias'); END;
      CREATE TRIGGER library_albums_alias_id_conflict_update
        BEFORE UPDATE OF id ON library_albums
        WHEN EXISTS (SELECT 1 FROM library_album_aliases WHERE alias_id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'library album current id conflicts with an alias'); END;
    `,
  },
  {
    version: 18,
    name: "album_metadata_governance",
    sql: `
      ALTER TABLE library_albums ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0
        CHECK(metadata_revision >= 0);
      ALTER TABLE library_issues ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK(resolution_status IN ('PENDING','RESOLVED_BY_METADATA'));

      CREATE TABLE library_metadata_values (
        scope_type TEXT NOT NULL CHECK(scope_type IN ('ALBUM','VERSION')),
        owner_id TEXT NOT NULL,
        field_name TEXT NOT NULL CHECK(field_name IN (
          'title','albumArtist','year','label','catalogNumber','barcode','country','releaseDate'
        )),
        source_type TEXT NOT NULL CHECK(source_type IN ('USER_OVERRIDE','CONFIRMED_EXTERNAL')),
        value_json TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        actor_id TEXT,
        actor_display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope_type, owner_id, field_name, source_type),
        CHECK((scope_type='ALBUM' AND field_name IN ('title','albumArtist','year')) OR
              (scope_type='VERSION' AND field_name IN ('label','catalogNumber','barcode','country','releaseDate')))
      );
      CREATE INDEX library_metadata_values_owner_idx
        ON library_metadata_values(scope_type,owner_id,source_type,field_name);

      CREATE TABLE library_metadata_events (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        library_album_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('UPDATE','CONFIRM_EXTERNAL','UNDO')),
        actor_id TEXT NOT NULL,
        actor_display_name TEXT NOT NULL,
        expected_metadata_revision INTEGER NOT NULL CHECK(expected_metadata_revision >= 0),
        resulting_metadata_revision INTEGER NOT NULL CHECK(resulting_metadata_revision >= 0),
        input_json TEXT NOT NULL,
        commands_json TEXT NOT NULL,
        before_state_json TEXT NOT NULL,
        after_state_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        compensates_event_id TEXT REFERENCES library_metadata_events(id),
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX library_metadata_events_compensation_idx
        ON library_metadata_events(compensates_event_id)
        WHERE compensates_event_id IS NOT NULL;
      CREATE INDEX library_metadata_events_album_idx
        ON library_metadata_events(library_album_id,created_at DESC,id DESC);
      CREATE TABLE library_metadata_event_groups (
        event_id TEXT NOT NULL REFERENCES library_metadata_events(id),
        library_album_id TEXT NOT NULL,
        PRIMARY KEY(event_id,library_album_id)
      );
      CREATE INDEX library_metadata_event_groups_album_idx
        ON library_metadata_event_groups(library_album_id,event_id);
      CREATE TRIGGER library_metadata_events_no_update BEFORE UPDATE ON library_metadata_events
        BEGIN SELECT RAISE(ABORT, 'library metadata event ledger is append-only'); END;
      CREATE TRIGGER library_metadata_events_no_delete BEFORE DELETE ON library_metadata_events
        BEGIN SELECT RAISE(ABORT, 'library metadata event ledger is append-only'); END;
      CREATE TRIGGER library_metadata_event_groups_no_update BEFORE UPDATE ON library_metadata_event_groups
        BEGIN SELECT RAISE(ABORT, 'library metadata event group ledger is append-only'); END;
      CREATE TRIGGER library_metadata_event_groups_no_delete BEFORE DELETE ON library_metadata_event_groups
        BEGIN SELECT RAISE(ABORT, 'library metadata event group ledger is append-only'); END;

      INSERT INTO library_metadata_values
        (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
         actor_id,actor_display_name,created_at,updated_at)
      SELECT 'VERSION',id,'label','CONFIRMED_EXTERNAL',json_quote(label),
             json_object('provider','MUSICBRAINZ','candidateId',musicbrainz_release_id),
             NULL,NULL,updated_at,updated_at
      FROM albums WHERE match_status='USER_CONFIRMED' AND label IS NOT NULL;
      INSERT INTO library_metadata_values
        (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
         actor_id,actor_display_name,created_at,updated_at)
      SELECT 'VERSION',id,'catalogNumber','CONFIRMED_EXTERNAL',json_quote(catalog_number),
             json_object('provider','MUSICBRAINZ','candidateId',musicbrainz_release_id),
             NULL,NULL,updated_at,updated_at
      FROM albums WHERE match_status='USER_CONFIRMED' AND catalog_number IS NOT NULL;
      INSERT INTO library_metadata_values
        (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
         actor_id,actor_display_name,created_at,updated_at)
      SELECT 'VERSION',id,'barcode','CONFIRMED_EXTERNAL',json_quote(barcode),
             json_object('provider','MUSICBRAINZ','candidateId',musicbrainz_release_id),
             NULL,NULL,updated_at,updated_at
      FROM albums WHERE match_status='USER_CONFIRMED' AND barcode IS NOT NULL;
      INSERT INTO library_metadata_values
        (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
         actor_id,actor_display_name,created_at,updated_at)
      SELECT 'VERSION',id,'country','CONFIRMED_EXTERNAL',json_quote(country),
             json_object('provider','MUSICBRAINZ','candidateId',musicbrainz_release_id),
             NULL,NULL,updated_at,updated_at
      FROM albums WHERE match_status='USER_CONFIRMED' AND country IS NOT NULL;
      INSERT INTO library_metadata_values
        (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
         actor_id,actor_display_name,created_at,updated_at)
      SELECT 'VERSION',id,'releaseDate','CONFIRMED_EXTERNAL',json_quote(release_date),
             json_object('provider','MUSICBRAINZ','candidateId',musicbrainz_release_id),
             NULL,NULL,updated_at,updated_at
      FROM albums WHERE match_status='USER_CONFIRMED' AND release_date IS NOT NULL;
    `,
  },
  {
    version: 19,
    name: "album_artwork_governance",
    sql: `
      ALTER TABLE library_albums ADD COLUMN artwork_revision INTEGER NOT NULL DEFAULT 0
        CHECK(artwork_revision >= 0);
      ALTER TABLE library_albums ADD COLUMN effective_artwork_json TEXT;
      ALTER TABLE library_albums ADD COLUMN effective_artwork_source TEXT NOT NULL DEFAULT 'NONE'
        CHECK(effective_artwork_source IN (
          'USER_SELECTED','USER_HIDDEN','AUTOMATIC_PRIMARY','AUTOMATIC_REPRESENTATIVE','NONE'
        ));

      DROP INDEX library_issues_code_idx;
      DROP INDEX library_issues_identity_idx;
      ALTER TABLE library_issues RENAME TO library_issues_v18;
      CREATE TABLE library_issues (
        library_album_id TEXT NOT NULL REFERENCES library_albums(id) ON DELETE CASCADE,
        album_id TEXT REFERENCES albums(id) ON DELETE CASCADE,
        code TEXT NOT NULL CHECK(code IN (
          'IDENTITY_OVERLAP','INCOMPLETE_TRACKS','MISSING_ARTWORK',
          'LOW_RES_ARTWORK','MIXED_AUDIO_SPECS','BROKEN_TEXT','MISSING_IDENTITY'
        )),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolution_status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK(resolution_status IN ('PENDING','RESOLVED_BY_METADATA','RESOLVED_BY_ARTWORK')),
        PRIMARY KEY(library_album_id, code, album_id)
      );
      INSERT INTO library_issues
        (library_album_id,album_id,code,evidence_json,created_at,updated_at,resolution_status)
      SELECT library_album_id,album_id,code,evidence_json,created_at,updated_at,resolution_status
      FROM library_issues_v18;
      DROP TABLE library_issues_v18;
      CREATE INDEX library_issues_code_idx
        ON library_issues(code, library_album_id);
      CREATE UNIQUE INDEX library_issues_identity_idx
        ON library_issues(library_album_id, code, COALESCE(album_id, char(0)));

      CREATE TABLE library_artwork_assets (
        sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
        mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp')),
        width INTEGER NOT NULL CHECK(width > 0),
        height INTEGER NOT NULL CHECK(height > 0),
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        extension TEXT NOT NULL CHECK(extension IN ('.jpg','.png','.webp')),
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER library_artwork_assets_no_update BEFORE UPDATE ON library_artwork_assets
        BEGIN SELECT RAISE(ABORT, 'library artwork asset is immutable'); END;
      CREATE TRIGGER library_artwork_assets_no_delete BEFORE DELETE ON library_artwork_assets
        BEGIN SELECT RAISE(ABORT, 'library artwork asset is immutable'); END;

      CREATE TABLE library_artwork_candidates (
        id TEXT PRIMARY KEY,
        library_album_id TEXT NOT NULL REFERENCES library_albums(id) ON DELETE CASCADE,
        local_version_id TEXT,
        asset_sha256 TEXT NOT NULL REFERENCES library_artwork_assets(sha256),
        source_type TEXT NOT NULL CHECK(source_type IN (
          'OBSERVED_EMBEDDED','OBSERVED_SIDECAR','USER_UPLOAD','MUSICBRAINZ_CAA'
        )),
        relative_path TEXT,
        kind TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX library_artwork_candidates_album_idx
        ON library_artwork_candidates(library_album_id,is_current,source_type,id);
      CREATE INDEX library_artwork_candidates_asset_idx
        ON library_artwork_candidates(asset_sha256,library_album_id);

      CREATE TABLE library_artwork_selections (
        library_album_id TEXT PRIMARY KEY REFERENCES library_albums(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('SELECTED','HIDDEN')),
        asset_sha256 TEXT REFERENCES library_artwork_assets(sha256),
        candidate_id TEXT REFERENCES library_artwork_candidates(id) ON DELETE SET NULL,
        actor_id TEXT NOT NULL,
        actor_display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((state='SELECTED' AND asset_sha256 IS NOT NULL) OR
              (state='HIDDEN' AND asset_sha256 IS NULL AND candidate_id IS NULL))
      );

      CREATE TABLE library_artwork_events (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        library_album_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN (
          'SELECT','HIDE','RESET','UPLOAD','IMPORT','UNDO'
        )),
        actor_id TEXT NOT NULL,
        actor_display_name TEXT NOT NULL,
        expected_artwork_revision INTEGER NOT NULL CHECK(expected_artwork_revision >= 0),
        resulting_artwork_revision INTEGER NOT NULL CHECK(resulting_artwork_revision >= 0),
        input_json TEXT NOT NULL,
        before_state_json TEXT NOT NULL,
        after_state_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        asset_sha256 TEXT,
        candidate_id TEXT,
        compensates_event_id TEXT REFERENCES library_artwork_events(id),
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX library_artwork_events_compensation_idx
        ON library_artwork_events(compensates_event_id)
        WHERE compensates_event_id IS NOT NULL;
      CREATE INDEX library_artwork_events_album_idx
        ON library_artwork_events(library_album_id,created_at DESC,id DESC);
      CREATE TABLE library_artwork_event_groups (
        event_id TEXT NOT NULL REFERENCES library_artwork_events(id),
        library_album_id TEXT NOT NULL,
        PRIMARY KEY(event_id,library_album_id)
      );
      CREATE INDEX library_artwork_event_groups_album_idx
        ON library_artwork_event_groups(library_album_id,event_id);
      CREATE TRIGGER library_artwork_events_no_update BEFORE UPDATE ON library_artwork_events
        BEGIN SELECT RAISE(ABORT, 'library artwork event ledger is append-only'); END;
      CREATE TRIGGER library_artwork_events_no_delete BEFORE DELETE ON library_artwork_events
        BEGIN SELECT RAISE(ABORT, 'library artwork event ledger is append-only'); END;
      CREATE TRIGGER library_artwork_event_groups_no_update BEFORE UPDATE ON library_artwork_event_groups
        BEGIN SELECT RAISE(ABORT, 'library artwork event group ledger is append-only'); END;
      CREATE TRIGGER library_artwork_event_groups_no_delete BEFORE DELETE ON library_artwork_event_groups
        BEGIN SELECT RAISE(ABORT, 'library artwork event group ledger is append-only'); END;
    `,
  },
  {
    version: 20,
    name: "library_lifecycle_governance",
    sql: `
      ALTER TABLE library_albums ADD COLUMN visibility TEXT NOT NULL DEFAULT 'VISIBLE'
        CHECK(visibility IN ('VISIBLE','HIDDEN'));
      ALTER TABLE library_albums ADD COLUMN visibility_revision INTEGER NOT NULL DEFAULT 0
        CHECK(visibility_revision >= 0);
      ALTER TABLE library_albums ADD COLUMN visibility_updated_at TEXT;

      CREATE TABLE library_visibility_events (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        library_album_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('HIDE','RESTORE')),
        actor_id TEXT NOT NULL,
        actor_display_name TEXT NOT NULL,
        expected_visibility_revision INTEGER NOT NULL CHECK(expected_visibility_revision >= 0),
        resulting_visibility_revision INTEGER NOT NULL CHECK(resulting_visibility_revision >= 0),
        before_visibility TEXT NOT NULL CHECK(before_visibility IN ('VISIBLE','HIDDEN')),
        after_visibility TEXT NOT NULL CHECK(after_visibility IN ('VISIBLE','HIDDEN')),
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX library_visibility_events_album_idx
        ON library_visibility_events(library_album_id,created_at DESC,id DESC);
      CREATE TRIGGER library_visibility_events_no_update
        BEFORE UPDATE ON library_visibility_events
        BEGIN SELECT RAISE(ABORT, 'library visibility event ledger is append-only'); END;
      CREATE TRIGGER library_visibility_events_no_delete
        BEFORE DELETE ON library_visibility_events
        BEGIN SELECT RAISE(ABORT, 'library visibility event ledger is append-only'); END;

      CREATE TABLE library_change_plans (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL CHECK(action IN ('QUARANTINE_VERSION','RESTORE_VERSION')),
        status TEXT NOT NULL CHECK(status IN (
          'PREVIEWED','QUEUED','RUNNING','SUCCEEDED','FAILED','RECOVERY_REQUIRED','CANCELLED'
        )),
        library_album_id TEXT NOT NULL,
        local_version_id TEXT NOT NULL,
        root_id TEXT NOT NULL,
        root_container_path TEXT NOT NULL,
        quarantine_root_path TEXT NOT NULL,
        source_plan_id TEXT,
        expected_library_revision INTEGER NOT NULL CHECK(expected_library_revision >= 0),
        input_json TEXT NOT NULL,
        executable INTEGER NOT NULL CHECK(executable IN (0,1)),
        blockers_json TEXT NOT NULL DEFAULT '[]',
        file_count INTEGER NOT NULL CHECK(file_count >= 0),
        total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
        actor_id TEXT NOT NULL,
        actor_display_name TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX library_change_plans_album_idx
        ON library_change_plans(library_album_id,created_at DESC,id DESC);
      CREATE INDEX library_change_plans_status_idx
        ON library_change_plans(status,created_at,id);
      CREATE UNIQUE INDEX library_change_plans_one_active_version_idx
        ON library_change_plans(local_version_id)
        WHERE status IN ('PREVIEWED','QUEUED','RUNNING','RECOVERY_REQUIRED');
      CREATE TRIGGER delivery_jobs_block_active_lifecycle
        BEFORE INSERT ON delivery_jobs
        WHEN NEW.status IN ('QUEUED','RUNNING') AND EXISTS (
          SELECT 1 FROM library_change_plans p
          WHERE p.local_version_id=NEW.album_id
            AND p.status IN ('PREVIEWED','QUEUED','RUNNING','RECOVERY_REQUIRED')
        )
        BEGIN SELECT RAISE(ABORT, 'active library lifecycle plan exists'); END;
      CREATE TRIGGER library_change_plans_no_delete
        BEFORE DELETE ON library_change_plans
        BEGIN SELECT RAISE(ABORT, 'library change plan ledger cannot be deleted'); END;
      CREATE TRIGGER library_change_plans_frozen_identity
        BEFORE UPDATE OF id,request_id,action,library_album_id,local_version_id,root_id,
          root_container_path,quarantine_root_path,source_plan_id,
          expected_library_revision,file_count,total_bytes,actor_id,
          actor_display_name,input_json,created_at ON library_change_plans
        BEGIN SELECT RAISE(ABORT, 'library change plan identity is frozen'); END;

      CREATE TABLE library_change_plan_items (
        plan_id TEXT NOT NULL REFERENCES library_change_plans(id),
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        media_file_id TEXT,
        source_relative_path TEXT NOT NULL,
        quarantine_relative_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        sha256 TEXT CHECK(sha256 IS NULL OR length(sha256)=64),
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN (
          'PENDING','SOURCE','QUARANTINED','RESTORED','CONFLICT','MISSING','FAILED'
        )),
        final_size_bytes INTEGER,
        final_sha256 TEXT,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plan_id,ordinal),
        UNIQUE(plan_id,source_relative_path),
        UNIQUE(plan_id,quarantine_relative_path)
      );
      CREATE TRIGGER library_change_plan_items_frozen_evidence
        BEFORE UPDATE OF plan_id,ordinal,media_file_id,source_relative_path,
          quarantine_relative_path,size_bytes,sha256 ON library_change_plan_items
        BEGIN SELECT RAISE(ABORT, 'library change plan item evidence is frozen'); END;
      CREATE TRIGGER library_change_plan_items_no_delete
        BEFORE DELETE ON library_change_plan_items
        BEGIN SELECT RAISE(ABORT, 'library change plan item ledger cannot be deleted'); END;

      CREATE TABLE library_change_events (
        id TEXT PRIMARY KEY,
        request_id TEXT UNIQUE,
        plan_id TEXT NOT NULL REFERENCES library_change_plans(id),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'PREVIEW','CONFIRM','START','ITEM_UPDATE','COMPLETE','FAIL','RECOVERY_REQUIRED','CANCEL'
        )),
        actor_id TEXT NOT NULL,
        actor_display_name TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX library_change_events_plan_idx
        ON library_change_events(plan_id,created_at,id);
      CREATE TRIGGER library_change_events_no_update
        BEFORE UPDATE ON library_change_events
        BEGIN SELECT RAISE(ABORT, 'library change event ledger is append-only'); END;
      CREATE TRIGGER library_change_events_no_delete
        BEFORE DELETE ON library_change_events
        BEGIN SELECT RAISE(ABORT, 'library change event ledger is append-only'); END;
    `,
  },
  {
    version: 21,
    name: "safe_orphan_governance",
    sql: `
      CREATE TABLE library_orphan_governance_events (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        local_version_id TEXT NOT NULL,
        library_album_id TEXT,
        resulting_library_album_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('APPLIED','REJECTED')),
        action TEXT NOT NULL CHECK(action IN (
          'DETACH_TO_HIDDEN_HISTORY','HIDE_HISTORY_GROUP','CLOSE_ORPHAN_IDENTITY'
        )),
        actor_id TEXT NOT NULL,
        actor_display_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        expected_fingerprint TEXT NOT NULL CHECK(length(expected_fingerprint)=64),
        before_state_json TEXT,
        expected_state_json TEXT,
        after_state_json TEXT,
        result_json TEXT NOT NULL,
        error_code TEXT CHECK(error_code IS NULL OR error_code IN (
          'ORPHAN_TARGET_NOT_FOUND','NO_AUTHORITATIVE_SCAN',
          'ORPHAN_GOVERNANCE_CONFLICT','ORPHAN_GOVERNANCE_NOT_EXECUTABLE'
        )),
        created_at TEXT NOT NULL
      );
      CREATE INDEX library_orphan_governance_events_version_idx
        ON library_orphan_governance_events(local_version_id,created_at DESC,id DESC);
      CREATE INDEX library_orphan_governance_events_album_idx
        ON library_orphan_governance_events(library_album_id,created_at DESC,id DESC);
      CREATE TRIGGER library_orphan_governance_events_no_update
        BEFORE UPDATE ON library_orphan_governance_events
        BEGIN SELECT RAISE(ABORT, 'library orphan governance event ledger is append-only'); END;
      CREATE TRIGGER library_orphan_governance_events_no_delete
        BEFORE DELETE ON library_orphan_governance_events
        BEGIN SELECT RAISE(ABORT, 'library orphan governance event ledger is append-only'); END;
    `,
  },
] as const;
