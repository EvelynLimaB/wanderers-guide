# Pathbuilder 2e 1:1 Import Contract

## Scope

The Pathbuilder importer must reproduce the character represented by the share payload without silently dropping player choices. The raw share payload remains the authoritative editor-state input. json.php is enrichment only because shared builds can legitimately return 404/403.

## Required invariants

1. A required Pathbuilder selection with no matching Wanderer's Guide option is a hard import failure. It must never be downgraded to a warning.
2. Selection resolution is bounded and deterministic. A malformed or non-converging operation tree must fail before character creation.
3. Character creation happens only after all required selections are resolved.
4. Unresolved data that can be preserved losslessly is stored in import provenance; data that changes the mechanical character must not be presented as a successful 1:1 import.
5. Custom Files remain verbatim in provenance and are materialized as private WG content when needed.
6. The importer must preserve Pathbuilder weapon state needed for the imported sheet, including potency, striking, property runes, selected attack ability, and two-hand state.
7. Regression tests use captured real Pathbuilder payloads. Build 1597410 is the primary golden case and its PDF is the human-readable sheet oracle.

## Verification layers

- Wire: Pathbuilder share payload validates and unknown fields survive.
- Resolution: every payload choice is represented in the normalized build.
- Construction: WG operations converge to a fully populated Character without unresolved required selections.
- Mechanical parity: the operation engine's final values are compared to golden expected values where an independent Pathbuilder derived payload is unavailable.
- Online certification: when json.php is available, its independent derived values are compared before create-character.

## Golden build 1597410

The captured share payload is level 7 Kasane, Automaton / Hunter Automaton, Champion, with ancestry paragon and free archetype enabled. The checked-in PDF oracle records ability scores 18/14/16/10/12/16, AC 24, HP 99, Speed 45, Perception +10, Fort +14, Ref +11, Will +12, Athletics +18, plus the listed attacks and focus/innate spell state.

The real json.php?id=1597410 endpoint returned 404 during capture. The absence of derived data is therefore a tested and supported condition, not a reason to fabricate a derived fixture.

## Non-goals

This contract does not claim every future Pathbuilder rule or third-party custom effect is executable. Unsupported mechanical effects must remain explicitly represented and must block a certified 1:1 import when they affect calculated character state.