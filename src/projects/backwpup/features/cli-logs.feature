@plugin
Feature: Reading and deleting BackWPup's job logs over WP-CLI

  Every run of a job writes a log. `wp backwpup log-show` prints one as plain text, and `log-delete`
  removes them — by name, by age, or all at once. Both take a log's file name, and both keep to the
  plugin's own log folder whatever path they are handed.

  Which log a scenario means comes from the backup history, where every run records the log it
  wrote: `{oldest log}` and `{newest log}` are the logs of the first and the latest run it records.
  Whether a log is still there is read off the log folder itself, never through the plugin's listing
  command, which shares its code with `log-delete`. And `log-delete` own line is never taken as
  proof: it reports success when it could not delete the log it found, and without `--yes` it stops
  at a question nobody answers and ends at exit 0.

  The runs are made inside WP-CLI, so their logs belong to WP-CLI's user — the web server's own where
  the suite runs site commands as it — which is what lets a scenario make one look old, or make one
  read-only.

  Two runs made back to back can write their logs in the same second, and the plugin orders logs by
  their modification time in whole seconds, so the oldest run's log is set a minute back: "newest"
  then means one log.

  Background:
    Given BackWPup is set up to back up the "database" on a schedule
    And the scheduled job has made 2 backups inside WP-CLI
    And the oldest run's log was last written 1 minute ago

  Scenario: Showing a log by its name prints that run's log as plain text
    When I run the BackWPup command "log-show {oldest log}"
    Then the command succeeds
    And it printed the oldest run's log as plain text

  Scenario: Showing a job's log prints its newest run, and --lines keeps only that log's last lines
    When I run the BackWPup command "log-show --job_id={job}"
    Then the command succeeds
    And it printed the newest run's log as plain text
    When I run the BackWPup command "log-show {newest log} --lines=3"
    Then the command succeeds
    And it printed only the last 3 lines of the newest run's log

  Scenario: Deleting a log by its name takes --yes, then removes that log and leaves the other
    When I run the BackWPup command "log-delete {oldest log}"
    Then the command succeeds
    And it asks "Delete logfile"
    And the log folder holds 2 logs
    When I run the BackWPup command "log-delete {oldest log} --yes"
    Then the command succeeds
    And it reports the success "1 logfile deleted."
    And the oldest run's log is gone from the log folder
    And the newest run's log is still in the log folder

  # A log's age is its file's modification time, which is what the command reads — not the time its
  # header records, which is what the listing command shows.
  Scenario: Deleting logs by age removes only the older ones, and deleting them all empties the log folder
    Given the oldest run's log was last written 10 days ago
    When I run the BackWPup command "log-delete --older-than=7days --yes"
    Then the command succeeds
    And the oldest run's log is gone from the log folder
    And the newest run's log is still in the log folder
    When I run the BackWPup command "log-delete --all --yes"
    Then the command succeeds
    And the log folder holds no logs
    When I run the BackWPup command "log"
    Then it prints "No logs found."

  # Deliberately silent about the exit code and the last line: the command reports "No logfile
  # deleted." as a success, at exit 0, which is a plugin bug to report rather than behaviour to pin.
  Scenario: A log that has been made read-only survives a delete, which only warns about it
    Given the newest run's log has been made read-only
    When I run the BackWPup command "log-delete {newest log} --yes"
    Then it reports the warning "is not writable"
    And the log folder holds 2 logs
    When I run the BackWPup command "log-delete --all --yes"
    Then it reports the warning "is not writable"
    And the log folder holds 1 log
    And the newest run's log is still in the log folder

  Scenario: The log commands refuse a log they cannot find or a request they cannot carry out, and delete nothing
    When I run the BackWPup command "log-show backwpup_log_000000_2000-01-01_00-00-00.html"
    Then the command fails
    And it reports the error "not found or unreadable"
    When I run the BackWPup command "log-show --job_id=999"
    Then the command fails
    And it reports the error "No logs found for the given job_id."
    When I run the BackWPup command "log-show"
    Then the command fails
    And it reports the error "Please provide"
    When I run the BackWPup command "log-delete backwpup_log_000000_2000-01-01_00-00-00.html --yes"
    Then the command fails
    And it reports the error "not found or unreadable"
    When I run the BackWPup command "log-delete --yes"
    Then the command fails
    And it reports the error "or --older-than, or --all."
    When I run the BackWPup command "log-delete --older-than=soon --yes"
    Then the command fails
    And it reports the error "Invalid --older-than value."
    # The command's own documentation offers a dry run its code would ignore — it passes the flag to a
    # function that takes no such argument. WP-CLI refuses the option, and nothing may be deleted.
    When I run the BackWPup command "log-delete --all --dry-run --yes"
    Then the command fails
    And it reports the error "unknown --dry-run parameter"
    And the log folder holds 2 logs

  Scenario: A path leading out of the log folder reaches no file, for showing or for deleting
    When I run the BackWPup command "log-show {path from the log folder to the marker file}"
    Then the command fails
    And it reports the error "not found or unreadable"
    And it printed nothing of the marker file
    When I run the BackWPup command "log-delete {path from the log folder to the marker file} --yes"
    Then the command fails
    And it reports the error "not found or unreadable"
    And the marker file is still on the site, as planted
