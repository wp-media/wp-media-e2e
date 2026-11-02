# Driven by `reporting/live-block.run.spec.ts` through the real `bddgen`, runner and the suite's
# reporters, on two placeholder sites — never collected by a product, whose features live under
# `src/projects/`. Every scenario is `@noauth`: nothing here touches a site.
Feature: The live block, end to end

  @noauth
  Scenario: Live block scenario one passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario two passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario three passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario four passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario five passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario six passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario seven passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario eight passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario nine passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario ten passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario eleven passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario twelve passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario thirteen passes
    Given the scenario takes its time

  @noauth
  Scenario: Live block scenario fourteen passes
    Given the scenario takes its time

  @noauth
  Scenario: A scenario whose title runs long enough to need cutting in any live row, past one hundred and twenty columns of text, passes
    Given the scenario takes its time

  @noauth
  Scenario: A scenario whose worker prints a warning passes
    Given the worker prints a warning

  @noauth
  Scenario: A scenario that makes the runner write to its own output passes
    Given the runner writes to its own output

  @noauth
  Scenario: A live block scenario that fails on its first attempt passes on its retry
    Given the first attempt fails

  @noauth
  Scenario: A live block scenario that fails on every attempt fails
    Given every attempt fails
