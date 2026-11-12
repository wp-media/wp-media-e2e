@plugin
Feature: Deleting and downloading BackWPup backups over WP-CLI

  `wp backwpup backup-delete` removes an archive from the storages that hold it, and
  `backup-download` copies one to a file of the user's choosing. Both run on the site, inside
  WP-CLI, so both act as WP-CLI's own user: the web server's where the suite runs site commands as
  it, else the SSH user. Where the two differ, that decides what they may do. An archive made by a
  run inside WP-CLI belongs to WP-CLI's user, and deleting it works. One the web server made — every
  scheduled or on-demand backup is — belongs to the web server and carries its file mode, and the
  plugin refuses to delete what WP-CLI may not write, although WP-CLI may still read it and download
  it. The scenario about that refusal runs WP-CLI as the SSH user, so the two differ whoever site
  commands otherwise run as.

  Every outcome is read off the site's own filesystem, and every archive is held to the digest it had
  when its run made it, so "left as it was" means byte for byte. Neither command's own line is taken
  as proof: without `--yes`, a delete — and a download onto a file already there — stops at a
  question nobody answers and ends at exit 0 having done nothing, and after one refused delete the
  next one exits 1 for a file it did remove.

  A download lands on the site, and a relative destination is resolved against the directory WP-CLI
  runs in — here the WordPress root. Each scenario downloads into a folder of its own, which
  `{private folder}` names relative to that root: private to WP-CLI's user (and outside the docroot
  when that user is the web server, which serves anything it can read there), and removed
  afterwards. `{oldest backup}` and
  `{newest backup}` are the archives of the first and the latest backup the scenario made. The job
  backs up the database only, the smallest real backup a site can make.

  Background:
    Given BackWPup is set up to back up the "database" on a schedule

  Scenario: Deleting a backup WP-CLI made takes --yes, then removes that archive and leaves the other one untouched
    Given the scheduled job has made 2 backups inside WP-CLI
    When I run the BackWPup command "backup-delete {oldest backup}"
    Then the command succeeds
    And it asks "Delete Backup file"
    And the oldest backup is still on the site, byte for byte
    When I run the BackWPup command "backup-delete {oldest backup} --yes"
    Then the command succeeds
    And it reports the success "deleted successfully on Folder."
    And the oldest backup is gone from the site
    And the newest backup is still on the site, byte for byte
    When I run the BackWPup command "backup --format=count"
    Then it prints "1"

  # One delete only. A refusal leaves its error queued on the site, and the next backup-delete repeats
  # it and exits 1 even for a file it did remove — a plugin bug, kept out of this scenario's way.
  Scenario: Deleting a backup the web server made is refused, and the archive and its history are left as they were
    Given WP-CLI runs as the SSH user, not the web server
    And the scheduled job has made 1 backup through the web server
    And WP-CLI's user may not write the newest backup
    When I run the BackWPup command "backup-delete {newest backup} --yes"
    Then the command fails
    And it reports the error "check permissions!"
    And the newest backup is still on the site, byte for byte
    And the backup history holds 1 completed run of the scheduled job, started by "backup_now_job"
    When I run the BackWPup command "backup --format=count"
    Then it prints "1"

  Scenario: Downloading a backup writes a byte-for-byte copy of it on the site, and replaces a file already there only with --yes
    Given the scheduled job has made 1 backup through the web server
    And the private folder already holds a file named "existing.tar"
    When I run the BackWPup command "backup-download {newest backup} {private folder}/"
    Then the command succeeds
    And it reports the success "Backup file downloaded successfully."
    And the private folder holds a byte-for-byte copy of the newest backup
    When I run the BackWPup command "backup-download {newest backup} {private folder}/existing.tar"
    Then the command succeeds
    And it asks "already exists. Overwrite it?"
    And the file "existing.tar" in the private folder is still the one placed there
    When I run the BackWPup command "backup-download {newest backup} {private folder}/existing.tar --yes"
    Then the command succeeds
    And the file "existing.tar" in the private folder is a byte-for-byte copy of the newest backup
    And the newest backup is still on the site, byte for byte

  # The backup is one WP-CLI may delete, so its surviving the storage filter is the filter's doing.
  Scenario: Deleting or downloading a backup the site does not hold, or from a storage it is not on, is refused, and nothing is deleted or copied
    Given the scheduled job has made 1 backup inside WP-CLI
    When I run the BackWPup command "backup-delete 2000-01-01_00-00-00_NOSUCHBACK_DBDUMP.tar --yes"
    Then the command fails
    And it reports the error "No Backup file 2000-01-01_00-00-00_NOSUCHBACK_DBDUMP.tar found for deletion."
    When I run the BackWPup command "backup-delete {newest backup} --storage=ftp --yes"
    Then the command fails
    And it reports the error "found for deletion."
    And the newest backup is still on the site, byte for byte
    When I run the BackWPup command "backup-download 2000-01-01_00-00-00_NOSUCHBACK_DBDUMP.tar {private folder}/"
    Then the command fails
    And it reports the error "Backup file not found."
    When I run the BackWPup command "backup-download {newest backup} {private folder}/ --storage=ftp"
    Then the command fails
    And it reports the error "Backup file not found in storage ftp."
    And nothing was downloaded
