@pro @plugin
Feature: Exporting and importing BackWPup jobs over WP-CLI

  `wp backwpup job-export` writes a job's settings to a JSON file, and `job-import` reads such a file
  back — both BackWPup Pro commands. An export carries a job's settings — those holding a value — and
  leaves out its schedule's state, its run history and every secret it stores: every job keeps the
  site's database password, encrypted, and the export drops it. An import without `--job_id` adds the file's job as a new one,
  under an id of its own and off the schedule; with `--job_id` it writes what the file carries over
  that job and keeps everything the file does not carry — its schedule included.

  Every claim is checked against the jobs the site stores, on the site, and answered in key names:
  the file carries the site's database host, name and user, so no value of it is ever quoted. Export
  files live in the scenario's private folder, which `{private folder}` names relative to the
  directory WP-CLI runs in, private to WP-CLI's user (outside the docroot when that user is the web
  server) and removed afterwards. `--passwords`, which
  writes stored secrets in clear, is deliberately not run.

  Kept out of these scenarios' way, each a plugin bug: an import that refuses a malformed job only
  after importing the ones before it, an export of a job the site does not have that reports success
  with an empty list, and an import of that empty list refused as "not a valid JSON file".

  Background:
    Given BackWPup is set up to back up the "database" on a schedule

  Scenario: Exporting a job writes its settings to a file, and none of its secrets, schedule state or run history
    When I run the BackWPup command "job-export {job} --file={private folder}/job.json"
    Then the command succeeds
    And it reports the success "Job exported successfully."
    And the export file "job.json" holds the scheduled job and no other
    And every setting the export file "job.json" carries is the scheduled job's own
    And every setting the scheduled job holds is in the export file "job.json", except its schedule, run history, secrets and empty ones
    And the export file "job.json" leaves out the job's schedule and run history
    And the export file "job.json" leaves out every secret the scheduled job stores

  Scenario: Importing an edited export over its own job writes what the file holds and keeps the job's schedule
    Given the scheduled job has been exported to "job.json"
    And the export file "job.json" names its job "Imported over the original"
    When I run the BackWPup command "job-import {private folder}/job.json --job_id={job}"
    Then the command succeeds
    And the scheduled job is now named "Imported over the original"
    And every setting the export file "job.json" carries is the scheduled job's own
    And the backup job is scheduled to run

  # The import is the scenario's last command: once the site holds a second job, "the scheduled job"
  # no longer names one, so what follows names each job by the export it came from.
  Scenario: Importing an export adds an unscheduled copy of the job under a new id, and leaves the job itself as it was
    Given the scheduled job has been exported to "job.json"
    When I run the BackWPup command "job-import {private folder}/job.json"
    Then the command succeeds
    And the site holds the job exported to "job.json" and one copy of it, under a different id
    And the copy of the job exported to "job.json" agrees with the job itself on every setting the export carries
    And the copy of the job exported to "job.json" is not scheduled to run, but the job itself still is

  # 999 is in neither the file nor the site. For a job the site holds but the file does not, the
  # refusal still says "No job with ID … found!" — misleading, and not pinned here.
  Scenario: An import refuses a path that is not there, a file that is not JSON, JSON that is not a job export and a job its file does not hold, and leaves the site's jobs as they were
    Given the scheduled job has been exported to "job.json"
    And the private folder holds a file named "notes.txt" reading "This is not a job export."
    And the private folder holds a file named "other.json" reading '{"a":1}'
    When I run the BackWPup command "job-import {private folder}/missing.json"
    Then the command fails
    And it reports the error "No file provided or file can't be found!"
    And the site's backup jobs are as they were when "job.json" was exported
    When I run the BackWPup command "job-import {private folder}/notes.txt"
    Then the command fails
    And it reports the error "File is not a valid JSON file!"
    And the site's backup jobs are as they were when "job.json" was exported
    When I run the BackWPup command "job-import {private folder}/other.json"
    Then the command fails
    And it reports the error "File is not a valid BackWPup job export file!"
    And the site's backup jobs are as they were when "job.json" was exported
    When I run the BackWPup command "job-import {private folder}/job.json --job_id=999"
    Then the command fails
    And it reports the error "No job with ID 999 found!"
    And the site's backup jobs are as they were when "job.json" was exported
