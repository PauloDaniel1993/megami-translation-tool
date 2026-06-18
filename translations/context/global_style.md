# Megami Translation Style

Translate into natural English visual-novel prose while preserving the source's pacing and character voice.

Core rules:
- Keep Celica's narration in first person.
- Preserve page rhythm; do not merge or split lines during the pilot.
- Use glossary spellings for names, places, menus, and recurring terms.
- Keep English CP932-safe. Prefer ASCII punctuation.
- Use `...` instead of ellipsis characters and straight quotes instead of curly quotes.
- In the default vanilla text profile, never use apostrophes or contractions.
- In the apostrophe-patched text profile, ASCII apostrophes are allowed.
- Never use em dashes, en dashes, curly quotes, or mojibake punctuation.
- Keep each rendered textbox line at or below 50 visible characters.
- The 50-character limit is a hard technical limit. Shorter and plainer is better than overflowing.
- Speaker pages have one speaker line plus up to 3 dialogue lines.
- Narration pages have up to 4 lines.
- Do not translate script labels unless they are proven visible.
- Translate UI/menu text separately from prose.

Model output rules:
- Return JSON only.
- Return translations keyed by `line_id`.
- Do not invent, remove, or rename line IDs.
- Do not translate speaker names creatively; use glossary names.
- Do not include Japanese in English fields unless a term is intentionally left untranslated.
- If a literal translation is too long, compress it while preserving meaning and tone.
