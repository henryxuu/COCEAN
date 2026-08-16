#!/usr/bin/env ruby
# frozen_string_literal: true

require "yaml"

compose_file = File.expand_path("../compose/fnos/compose.yaml", __dir__)
compose_source = File.read(compose_file)
document = YAML.safe_load(compose_source, aliases: true)
services = document.fetch("services")
errors = []

env_example = File.expand_path("../compose/fnos/.env.example", __dir__)
env_keys = []
env_values = {}
File.readlines(env_example, chomp: true).each do |line|
  next if line.empty? || line.start_with?("#") || !line.include?("=")

  key, value = line.split("=", 2)
  env_keys << key
  env_values[key] = value
end
required_variables = compose_source.scan(/\$\{([A-Z][A-Z0-9_]*):\?/).flatten.uniq
missing_variables = required_variables - env_keys
unless missing_variables.empty?
  errors << "required variables absent from .env.example: #{missing_variables.join(', ')}"
end

required_services = %w[web server worker provider-qobuz music-manifest acceptance-api acceptance-session db-maintenance]
missing_services = required_services - services.keys
errors << "missing services: #{missing_services.join(', ')}" unless missing_services.empty?

long_running = %w[web server worker provider-qobuz]
long_running.each do |name|
  service = services.fetch(name, {})
  errors << "#{name}: healthcheck missing" unless service.key?("healthcheck")
  errors << "#{name}: read_only must be true" unless service["read_only"] == true
  errors << "#{name}: user must be explicit" unless service["user"].is_a?(String)
  errors << "#{name}: cap_drop ALL missing" unless Array(service["cap_drop"]).include?("ALL")
  unless Array(service["security_opt"]).include?("no-new-privileges:true")
    errors << "#{name}: no-new-privileges missing"
  end
end

services.each do |name, service|
  errors << "#{name}: privileged mode is forbidden" if service["privileged"] == true
  errors << "#{name}: host network is forbidden" if service["network_mode"] == "host"
  if name != "web" && service.key?("ports")
    errors << "#{name}: only web may publish host ports"
  end
end

%w[web server worker].each do |name|
  node_image = services.fetch(name, {}).dig("build", "args", "NODE_IMAGE")
  unless node_image == "${NODE_IMAGE:-node:22.22.0-bookworm-slim}"
    errors << "#{name}: configurable Node base image mapping mismatch"
  end
  debian_mirror = services.fetch(name, {}).dig("build", "args", "DEBIAN_MIRROR")
  unless debian_mirror == "${DEBIAN_MIRROR:-}"
    errors << "#{name}: configurable Debian mirror mapping mismatch"
  end
end

{
  "web" => "${COCEAN_WEB_MEMORY_LIMIT:-256m}",
  "server" => "${COCEAN_SERVER_MEMORY_LIMIT:-768m}",
  "worker" => "${COCEAN_WORKER_MEMORY_LIMIT:-2g}"
}.each do |name, expected|
  unless services.fetch(name, {})["mem_limit"] == expected
    errors << "#{name}: configurable memory ceiling mismatch"
  end
end

def volume_for(service, target)
  Array(service["volumes"]).find { |volume| volume.is_a?(Hash) && volume["target"] == target }
end

%w[server worker].each do |name|
  music = volume_for(services.fetch(name, {}), "/library/music")
  errors << "#{name}: /library/music bind missing" unless music
  expected_read_only = name == "server" ? true : "${COCEAN_MUSIC_READ_ONLY:-true}"
  errors << "#{name}: /library/music mount policy mismatch" unless music && music["read_only"] == expected_read_only
end

services.each do |name, service|
  Array(service["volumes"]).each do |volume|
    next unless volume.is_a?(Hash) && volume["target"] == "/library/music"

    next if name == "worker"

    errors << "#{name}: every non-worker /library/music mount must be read-only" unless volume["read_only"] == true
  end
end

worker_inbox = volume_for(services.fetch("worker", {}), "/library/inbox")
errors << "worker: writable /library/inbox bind missing" unless worker_inbox && worker_inbox["read_only"] != true
worker_quarantine = volume_for(services.fetch("worker", {}), "/library/quarantine")
errors << "worker: writable /library/quarantine bind missing" unless worker_quarantine && worker_quarantine["read_only"] != true
unless worker_quarantine && worker_quarantine["source"].to_s.include?("COCEAN_QUARANTINE_DIR")
  errors << "worker: /library/quarantine must use COCEAN_QUARANTINE_DIR"
end
unless worker_quarantine && worker_quarantine.dig("bind", "create_host_path") == false
  errors << "worker: quarantine must refuse implicit host-path creation"
end

%w[server worker].each do |name|
  environment = services.fetch(name, {}).fetch("environment", {})
  unless environment["COCEAN_MUSIC_ROOT_POLICY"] == "${COCEAN_MUSIC_ROOT_POLICY:-WATCH_ONLY}"
    errors << "#{name}: Music root policy mapping mismatch"
  end
  unless environment["COCEAN_QUARANTINE_ROOT"] == "/library/quarantine"
    errors << "#{name}: quarantine root mapping mismatch"
  end
end

%w[server worker].each do |name|
  database_path = services.fetch(name, {}).fetch("environment", {})["COCEAN_DATABASE_PATH"]
  errors << "#{name}: SQLite database must live in /var/lib/cocean" unless database_path == "/var/lib/cocean/cocean.sqlite"
end

{
  "server" => {
    "/var/lib/cocean" => "COCEAN_DATA_DIR",
    "/var/cache/cocean" => "COCEAN_CACHE_DIR",
    "/delivery/usb" => "COCEAN_DELIVERY_DIR"
  },
  "worker" => {
    "/var/lib/cocean" => "COCEAN_DATA_DIR",
    "/var/cache/cocean" => "COCEAN_CACHE_DIR",
    "/library/inbox" => "COCEAN_INBOX_DIR",
    "/library/quarantine" => "COCEAN_QUARANTINE_DIR"
  }
}.each do |name, expected|
  expected.each do |target, source_name|
    volume = volume_for(services.fetch(name, {}), target)
    errors << "#{name}: #{target} bind missing" unless volume
    unless volume && volume["source"].to_s.include?(source_name)
      errors << "#{name}: #{target} must use #{source_name}"
    end
    unless volume && volume.dig("bind", "create_host_path") == false
      errors << "#{name}: #{target} must refuse implicit host-path creation"
    end
  end
end

provider_profiles = Array(services.fetch("provider-qobuz", {})["profiles"])
errors << "provider-qobuz: providers profile missing" unless provider_profiles.include?("providers")

provider = services.fetch("provider-qobuz", {})
errors << "provider-qobuz: current release must stay at scale 0" unless provider["scale"] == 0
errors << "provider-qobuz: restart must be disabled" unless provider["restart"] == "no"
errors << "provider-qobuz: network must be disabled" unless provider["network_mode"] == "none"
errors << "provider-qobuz: writable mounts are forbidden while disabled" unless Array(provider["volumes"]).empty?
errors << "provider-qobuz: secrets are forbidden while disabled" unless Array(provider["secrets"]).empty?
errors << "provider-qobuz: fail-closed command mismatch" unless Array(provider["command"]) == ["node", "/app/provider.mjs"]
unless provider.fetch("environment", {})["COCEAN_PROVIDER_DISABLED"] == "true"
  errors << "provider-qobuz: disabled marker missing"
end
unless Array(provider.dig("healthcheck", "test")).include?("/app/provider-healthcheck.mjs")
  errors << "provider-qobuz: fail-closed healthcheck missing"
end

acceptance_profiles = Array(services.fetch("music-manifest", {})["profiles"])
errors << "music-manifest: acceptance profile missing" unless acceptance_profiles.include?("acceptance")
errors << "music-manifest: network must be disabled" unless services.fetch("music-manifest", {})["network_mode"] == "none"
manifest = services.fetch("music-manifest", {})
errors << "music-manifest: read_only must be true" unless manifest["read_only"] == true
errors << "music-manifest: user must be explicit" unless manifest["user"].is_a?(String)
errors << "music-manifest: cap_drop ALL missing" unless Array(manifest["cap_drop"]).include?("ALL")
unless Array(manifest["security_opt"]).include?("no-new-privileges:true")
  errors << "music-manifest: no-new-privileges missing"
end
manifest_music = volume_for(manifest, "/library/music")
errors << "music-manifest: read-only Music mount missing" unless manifest_music && manifest_music["read_only"] == true
manifest_data = volume_for(manifest, "/var/lib/cocean")
errors << "music-manifest: data output mount missing" unless manifest_data
unless manifest.fetch("environment", {})["COCEAN_SCAN_EXCLUDE_DIRS"] == "${COCEAN_SCAN_EXCLUDE_DIRS:-[]}"
  errors << "music-manifest: scan exclusion mapping mismatch"
end

acceptance_api = services.fetch("acceptance-api", {})
api_acceptance_profiles = Array(acceptance_api["profiles"])
errors << "acceptance-api: acceptance profile missing" unless api_acceptance_profiles.include?("acceptance")
errors << "acceptance-api: restart must be disabled" unless acceptance_api["restart"] == "no"
errors << "acceptance-api: read_only must be true" unless acceptance_api["read_only"] == true
errors << "acceptance-api: user must be explicit" unless acceptance_api["user"].is_a?(String)
errors << "acceptance-api: cap_drop ALL missing" unless Array(acceptance_api["cap_drop"]).include?("ALL")
unless Array(acceptance_api["security_opt"]).include?("no-new-privileges:true")
  errors << "acceptance-api: no-new-privileges missing"
end
unless Array(acceptance_api["entrypoint"]) == ["python3", "/opt/cocean/fnos_api_acceptance.py"]
  errors << "acceptance-api: entrypoint mismatch"
end
unless Array(acceptance_api["networks"]) == ["backend"]
  errors << "acceptance-api: must use only the internal backend network"
end
errors << "acceptance-api: secrets are forbidden" unless Array(acceptance_api["secrets"]).empty?
if volume_for(acceptance_api, "/library/music") || volume_for(acceptance_api, "/library/inbox")
  errors << "acceptance-api: direct library mounts are forbidden"
end
acceptance_data = volume_for(acceptance_api, "/var/lib/cocean")
errors << "acceptance-api: data report mount missing" unless acceptance_data
unless acceptance_data && acceptance_data["source"].to_s.include?("COCEAN_DATA_DIR")
  errors << "acceptance-api: report mount must use COCEAN_DATA_DIR"
end
unless acceptance_data && acceptance_data.dig("bind", "create_host_path") == false
  errors << "acceptance-api: data mount must refuse implicit host-path creation"
end
if Array(acceptance_api["volumes"]).any? { |volume| volume.is_a?(Hash) && volume["read_only"] != true && volume["target"] != "/var/lib/cocean" }
  errors << "acceptance-api: only the data report mount may be writable"
end

acceptance_session = services.fetch("acceptance-session", {})
unless acceptance_session["image"] == services.fetch("server", {})["image"]
  errors << "acceptance-session: image must exactly match server image"
end
errors << "acceptance-session: maintenance profile missing" unless Array(acceptance_session["profiles"]).include?("maintenance")
errors << "acceptance-session: restart must be disabled" unless acceptance_session["restart"] == "no"
errors << "acceptance-session: read_only must be true" unless acceptance_session["read_only"] == true
errors << "acceptance-session: user must be explicit" unless acceptance_session["user"].is_a?(String)
errors << "acceptance-session: cap_drop ALL missing" unless Array(acceptance_session["cap_drop"]).include?("ALL")
unless Array(acceptance_session["security_opt"]).include?("no-new-privileges:true")
  errors << "acceptance-session: no-new-privileges missing"
end
errors << "acceptance-session: network must be disabled" unless acceptance_session["network_mode"] == "none"
unless Array(acceptance_session["entrypoint"]) == ["node", "/app/acceptance-session.mjs"]
  errors << "acceptance-session: entrypoint mismatch"
end
session_data = volume_for(acceptance_session, "/var/lib/cocean")
errors << "acceptance-session: data mount missing" unless session_data
unless session_data && session_data["source"].to_s.include?("COCEAN_DATA_DIR")
  errors << "acceptance-session: data mount must use COCEAN_DATA_DIR"
end
unless session_data && session_data.dig("bind", "create_host_path") == false
  errors << "acceptance-session: data mount must refuse implicit host-path creation"
end
errors << "acceptance-session: only the data mount is permitted" unless Array(acceptance_session["volumes"]).length == 1
errors << "acceptance-session: environment is forbidden" unless acceptance_session.fetch("environment", {}).empty?
errors << "acceptance-session: secrets are forbidden" unless Array(acceptance_session["secrets"]).empty?
%w[web worker].each do |dependency|
  unless acceptance_api.dig("depends_on", dependency, "condition") == "service_healthy"
    errors << "acceptance-api: #{dependency} healthy dependency missing"
  end
end

acceptance_environment = acceptance_api.fetch("environment", {})
{
  "COCEAN_ACCEPTANCE_BASE_URL" => "http://server:8080",
  "COCEAN_ACCEPTANCE_REPORT" => "/var/lib/cocean/acceptance/api-report.json",
  "COCEAN_ACCEPTANCE_MANIFEST" => "/var/lib/cocean/acceptance/music-before.jsonl",
  "COCEAN_ACCEPTANCE_MANIFEST_HASH" => "${COCEAN_ACCEPTANCE_MANIFEST_HASH:-sha256}",
  "COCEAN_SCAN_EXCLUDE_DIRS" => "${COCEAN_SCAN_EXCLUDE_DIRS:-[]}",
  "COCEAN_ACCEPTANCE_EXISTING_SCAN_ID" => "${COCEAN_ACCEPTANCE_EXISTING_SCAN_ID:-}",
  "COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS" => "${COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS:-}",
  "COCEAN_ACCEPTANCE_REQUEST_TIMEOUT" => "${COCEAN_ACCEPTANCE_REQUEST_TIMEOUT:-15}",
  "COCEAN_ACCEPTANCE_SCAN_TIMEOUT" => "${COCEAN_ACCEPTANCE_SCAN_TIMEOUT:-7200}",
  "COCEAN_ACCEPTANCE_POLL_INTERVAL" => "${COCEAN_ACCEPTANCE_POLL_INTERVAL:-2}",
  "COCEAN_ACCEPTANCE_MAX_FAILURES" => "${COCEAN_ACCEPTANCE_MAX_FAILURES:-0}",
  "COCEAN_ACCEPTANCE_MIN_ALBUMS" => "${COCEAN_ACCEPTANCE_MIN_ALBUMS:-1}",
  "COCEAN_ACCEPTANCE_MIN_ARTWORKS" => "${COCEAN_ACCEPTANCE_MIN_ARTWORKS:-1}",
  "COCEAN_ACCEPTANCE_MAX_MISSING_ARTWORKS" => "${COCEAN_ACCEPTANCE_MAX_MISSING_ARTWORKS:-0}",
  "COCEAN_ACCEPTANCE_MAX_ALBUM_ISSUES" => "${COCEAN_ACCEPTANCE_MAX_ALBUM_ISSUES:-0}",
  "COCEAN_ACCEPTANCE_MAX_IGNORED_FILES" => "${COCEAN_ACCEPTANCE_MAX_IGNORED_FILES:-0}",
  "COCEAN_ACCEPTANCE_MAX_SKIPPED_SYMLINKS" => "${COCEAN_ACCEPTANCE_MAX_SKIPPED_SYMLINKS:-0}",
  "COCEAN_ACCEPTANCE_MAX_CUE_FILES" => "${COCEAN_ACCEPTANCE_MAX_CUE_FILES:-0}",
  "COCEAN_ACCEPTANCE_MAX_OTHER_ENTRIES" => "${COCEAN_ACCEPTANCE_MAX_OTHER_ENTRIES:-0}",
  "COCEAN_ACCEPTANCE_MAX_TAG_WARNINGS" => "${COCEAN_ACCEPTANCE_MAX_TAG_WARNINGS:-0}",
  "COCEAN_ACCEPTANCE_MAX_TECHNICAL_WARNINGS" => "${COCEAN_ACCEPTANCE_MAX_TECHNICAL_WARNINGS:-0}",
  "COCEAN_ACCEPTANCE_LISTEN_MODE" => "${COCEAN_ACCEPTANCE_LISTEN_MODE:-each-track}"
}.each do |key, expected|
  errors << "acceptance-api: #{key} mapping mismatch" unless acceptance_environment[key] == expected
end
acceptance_environment.each_key do |key|
  if key.match?(/COOKIE|TOKEN|PASSWORD|SECRET/i)
    errors << "acceptance-api: sensitive environment key #{key} is forbidden"
  end
end

maintenance = services.fetch("db-maintenance", {})
errors << "db-maintenance: maintenance profile missing" unless Array(maintenance["profiles"]).include?("maintenance")
errors << "db-maintenance: restart must be disabled" unless maintenance["restart"] == "no"
errors << "db-maintenance: read_only must be true" unless maintenance["read_only"] == true
errors << "db-maintenance: user must be explicit" unless maintenance["user"].is_a?(String)
errors << "db-maintenance: cap_drop ALL missing" unless Array(maintenance["cap_drop"]).include?("ALL")
unless Array(maintenance["security_opt"]).include?("no-new-privileges:true")
  errors << "db-maintenance: no-new-privileges missing"
end
errors << "db-maintenance: network must be disabled" unless maintenance["network_mode"] == "none"
unless Array(maintenance["entrypoint"]) == ["node", "/app/backup.mjs"]
  errors << "db-maintenance: backup entrypoint mismatch"
end
maintenance_data = volume_for(maintenance, "/var/lib/cocean")
errors << "db-maintenance: data mount missing" unless maintenance_data
unless maintenance_data && maintenance_data["source"].to_s.include?("COCEAN_DATA_DIR")
  errors << "db-maintenance: data mount must use COCEAN_DATA_DIR"
end
unless maintenance_data && maintenance_data.dig("bind", "create_host_path") == false
  errors << "db-maintenance: data mount must refuse implicit host-path creation"
end
unless Array(maintenance["volumes"]).length == 1
  errors << "db-maintenance: only the data mount is permitted"
end
unless maintenance.fetch("environment", {})["COCEAN_DATABASE_PATH"] == "/var/lib/cocean/cocean.sqlite"
  errors << "db-maintenance: database path mismatch"
end
if Array(maintenance["secrets"]).any?
  errors << "db-maintenance: secrets are forbidden"
end

unless document.dig("networks", "backend", "internal") == true
  errors << "backend network must be internal"
end

errors << "server: metadata egress network missing" unless Array(services.fetch("server", {})["networks"]).include?("egress")
errors << "worker: local scanner must not have egress" if Array(services.fetch("worker", {})["networks"]).include?("egress")

web_environment = services.fetch("web", {}).fetch("environment", {})
server_environment = services.fetch("server", {}).fetch("environment", {})
worker_environment = services.fetch("worker", {}).fetch("environment", {})

errors << "web: PORT must match healthcheck contract" unless web_environment["PORT"] == "3000"
if web_environment.key?("COCEAN_BASIC_AUTH_FILE") || Array(services.fetch("web", {})["secrets"]).any?
  errors << "web: legacy Basic Auth configuration must be absent"
end
unless server_environment["COCEAN_AUTH_BOOTSTRAP_FILE"] == "/run/secrets/cocean_owner_bootstrap"
  errors << "server: owner bootstrap secret path mismatch"
end
unless Array(services.fetch("server", {})["secrets"]).include?("cocean_owner_bootstrap")
  errors << "server: owner bootstrap secret mount missing"
end
unless document.dig("secrets", "cocean_owner_bootstrap", "file").to_s.include?("COCEAN_WEB_AUTH_FILE")
  errors << "server: owner bootstrap secret source must be deployment-managed"
end
errors << "server: COCEAN_PORT must match healthcheck contract" unless server_environment["COCEAN_PORT"] == "8080"
unless Array(services.dig("web", "healthcheck", "test")).include?("/app/healthcheck.mjs")
  errors << "web: runtime healthcheck command mismatch"
end
server_healthcheck = Array(services.dig("server", "healthcheck", "test"))
unless server_healthcheck.first == "CMD-SHELL" && server_healthcheck.last.include?("/app/healthcheck.mjs")
  errors << "server: runtime healthcheck command mismatch"
end
unless server_healthcheck.last.to_s.include?("COCEAN_MUSICBRAINZ_ENABLED") &&
       server_healthcheck.last.to_s.include?("COCEAN_METADATA_CONTACT")
  errors << "server: metadata contact fail-closed healthcheck missing"
end
unless Array(services.dig("worker", "healthcheck", "test")).include?("/app/healthcheck.mjs")
  errors << "worker: runtime healthcheck command mismatch"
end

{
  "COCEAN_WORKER_POLL_MS" => "${COCEAN_WORKER_POLL_MS:-1500}",
  "COCEAN_WORKER_ONCE" => "false",
  "COCEAN_FFPROBE_PATH" => "${COCEAN_FFPROBE_PATH:-/usr/bin/ffprobe}",
  "COCEAN_FFPROBE_TIMEOUT_MS" => "${COCEAN_FFPROBE_TIMEOUT_MS:-30000}",
  "COCEAN_SCAN_EXCLUDE_DIRS" => "${COCEAN_SCAN_EXCLUDE_DIRS:-[]}"
}.each do |key, expected|
  errors << "worker: #{key} mapping mismatch" unless worker_environment[key] == expected
end

{
  "COCEAN_MUSICBRAINZ_ENABLED" => "${COCEAN_MUSICBRAINZ_ENABLED:-false}",
  "COCEAN_METADATA_CONTACT" => "${COCEAN_METADATA_CONTACT:-}"
}.each do |key, expected|
  errors << "server: #{key} mapping mismatch" unless server_environment[key] == expected
  errors << "worker: #{key} must not be present" if worker_environment.key?(key)
end

%w[COCEAN_ROLE COCEAN_INBOX_ROOT].each do |unused_key|
  if server_environment.key?(unused_key) || worker_environment.key?(unused_key)
    errors << "core: unused environment variable #{unused_key} must not be advertised"
  end
end

errors << "env example: MusicBrainz must default off" unless env_values["COCEAN_MUSICBRAINZ_ENABLED"] == "false"
errors << "env example: metadata contact must default empty" unless env_values["COCEAN_METADATA_CONTACT"] == ""
errors << "env example: scan exclusions must default empty" unless env_values["COCEAN_SCAN_EXCLUDE_DIRS"] == "[]"
unless env_values["NODE_IMAGE"] == "node:22.22.0-bookworm-slim"
  errors << "env example: Node base image default mismatch"
end
errors << "env example: Debian mirror must default empty" unless env_values["DEBIAN_MIRROR"] == ""
%w[QOBUZ_DL_BASE_URL COCEAN_QOBUZ_TOKEN_FILE].each do |forbidden_key|
  errors << "env example: #{forbidden_key} must not exist while Provider is disabled" if env_values.key?(forbidden_key)
end
declared_secrets = document.fetch("secrets", {}).keys
unexpected_secrets = declared_secrets - ["cocean_owner_bootstrap"]
unless unexpected_secrets.empty?
  errors << "compose: only the initial owner bootstrap secret may be declared; unexpected: #{unexpected_secrets.join(', ')}"
end

if errors.empty?
  puts "FNOS Compose contract: OK (#{services.length} services)"
else
  warn errors.map { |error| "- #{error}" }.join("\n")
  exit 1
end
