---
description: Product/domain rules for the active instance. Loaded on /sdlc-hydrate, not session start.
---

# Business Rules Memory

last_updated: 2026-07-08

## Update Protocol

Write when: domain constraint discovered, product scope changes, persona/rule added.
Spec wins for a single change; update this file in the same PR when spec supersedes a rule.
Keep under 600 tokens.

---

[PRODUCT]
name→_set_in_instance_project.yaml_
domain→_describe_product_domain_
[/PRODUCT]

[RULES]
# Adopter: replace with your product rules. Example placeholders only.
rule→spec_is_source_of_truth_for_single_change
rule→business_rules_summarize_durable_constraints_not_specs
[/RULES]

[GLOSSARY]
# Canonical terms for this product — keep terse, one line each.
# term→definition
[/GLOSSARY]
