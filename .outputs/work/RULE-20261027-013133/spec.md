---
id: RULE-20261027-013133
kind: rule
status: active
---
# When a session ends at any point (transport close, an OPEN or request reply with no status, disconnect()), every pending

## Rule

When a session ends at any point (transport close, an OPEN or request reply with no status, disconnect()), every pending request and stream settles exactly once with one typed RemoteFsError that carries its code and path, never an AggregateError or a second error, and a handle that arrives after the end is closed; an adversarial test covers each ending.
