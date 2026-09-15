"""Standalone validator for backend/data/drawing_words.json - run directly
(`python -m backend.validate_drawing_words`) to print a summary and catch
data problems before they'd surface as a broken Kritzelmeister round.

Reuses the exact same validation function drawing_game.py calls at import
time, so this script and the live server always agree on what "valid"
means - there is only one implementation of the rules.
"""
from .drawing_game import validate_word_bank, WORDS_PATH, VALID_CATEGORIES
import json


def main():
    with open(WORDS_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    words = validate_word_bank(raw)

    by_cat = {}
    by_diff = {1: 0, 2: 0, 3: 0}
    for w in words:
        by_cat[w["category"]] = by_cat.get(w["category"], 0) + 1
        by_diff[w["difficulty"]] += 1

    print(f"Total Drawing Words: {len(words)}")
    print()
    for cat in VALID_CATEGORIES:
        print(f"  {VALID_CATEGORIES[cat]} ({cat}): {by_cat.get(cat, 0)}")
    print()
    print(f"  Leicht (1): {by_diff[1]}")
    print(f"  Mittel (2): {by_diff[2]}")
    print(f"  Schwer (3): {by_diff[3]}")
    print()
    print("Word bank OK.")


if __name__ == "__main__":
    main()
