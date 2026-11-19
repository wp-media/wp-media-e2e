@wp-rocket @smoke @noauth
Feature: WP Rocket test runner scaffolding

  Scenario: The WP Rocket project is wired up
    Given a page titled "WP Rocket"
    Then the page title is "WP Rocket"
    And the heading mentions "WP Rocket"
    And the WP Rocket project marker is present

  # The device profile is tag-driven, so both halves need proving: the tag switches the whole
  # client (viewport, screen, touch, user agent, pixel ratio), and its absence leaves desktop
  # untouched.
  Scenario: An untagged scenario runs on desktop
    Given a page titled "WP Rocket"
    Then the browser emulates a desktop browser

  @mobile
  Scenario: A @mobile scenario runs on a mobile device
    Given a page titled "WP Rocket"
    Then the browser emulates a mobile device
