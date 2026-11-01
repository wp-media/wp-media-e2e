# Driven by `reporting/failure-block.run.spec.ts` on a placeholder site, through the real `bddgen`,
# runner and the suite's reporters — never collected by a product, whose features live under
# `src/projects/`. Every scenario is `@noauth`: nothing here touches a site. The second title holds an
# escape sequence and a bidi override on purpose: the terminal must print neither, and the rerun
# command must still select it. `Create a backup` is held by two longer titles, one tagged and one
# not: its rerun must select it alone.
Feature: Failure blocks, end to end

  @noauth
  Scenario: A secret typed into a field, then a failing check
    When a secret and a control are typed, then a check fails

  @noauth
  Scenario: Regex (a+b)* [x] {1} ^$ | 'single' "double" $HOME `tick` \ 👩‍💻 漢字 [31mred[0m ‮rtl‬ end
    When a step fails with "nasty"

  @noauth
  Scenario: Regex (a+b)* is a near miss that must not be selected
    When a step fails with "near miss"

  @noauth
  Scenario: A scenario that passes
    Given nothing happens

  @noauth
  Scenario: Create a backup
    When a step fails with "backup"

  @noauth @slow
  Scenario: Create a backup encrypted
    Given nothing happens

  Scenario: Untagged Create a backup
    Given nothing happens
