F4 VALUE HELP — WILDCARD SEARCH V5

Supported patterns in Package and Transport F4:
- Z*          starts with Z
- *ZCUST*     contains ZCUST
- *ZCUST***   same result as *ZCUST*
- *           all objects returned (subject to SAP/API result limits)
- ?           exactly one character
- ZCUST       treated as contains search for convenience

Package F4
- Uses ADT repository quickSearch with objectType=DEVC/K.
- For leading wildcard patterns, SAP is queried broadly and the exact wildcard
  match is applied locally to package name/description.
- Package names are also matched with whitespace removed, so accidental spaces
  in a pattern do not break identifier matching.

Transport F4
- Uses SAP ADT CTS transport organizer tree representation.
- Accept header is application/vnd.sap.adt.transportorganizertree.v1+xml,
  matching the representation reported by the connected system in the user's
  live error.
- Modifiable request IDs are filtered client-side using the same wildcard engine.

This is deliberately implemented as one reusable search engine so future F4
dialogs can share the same behavior.
