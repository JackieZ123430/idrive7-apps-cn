#!/usr/bin/env python3
import unittest

from import_diagnostic_ru import pack_pairs, pair_rows, translations_from_pairs


def row(label_id, variant, address, code, text):
    return {'id': str(label_id), 'context': (variant, address, code), 'text': text}


class DiagnosticRuImportTest(unittest.TestCase):
    def test_id_and_context_matching_and_conflicts(self):
        english = [
            row(1, 'dme', 0x12, 0x21f026, 'Engine fault'),
            row(2, 'dme', 0x12, 0x21f027, 'Same wording'),
            row(3, 'egs', 0x18, 0x421001, 'Same wording'),
            row(4, 'dme', 0x12, 0x21f028, 'Ambiguous context'),
            row(5, 'egs', 0x18, 0x421002, 'Ambiguous context'),
            row(6, 'abc', 0x40, 0x111111, 'Unmatched context'),
        ]
        russian = [
            row(1, 'dme', 0x12, 0x21f026, 'Ошибка двигателя'),
            row(20, 'dme', 0x12, 0x21f027, 'Ошибка ДМЕ'),
            row(30, 'egs', 0x18, 0x421001, 'Ошибка КПП'),
            row(40, 'dme', 0x12, 0x21f028, 'Первый вариант'),
            row(50, 'egs', 0x18, 0x421002, 'Второй вариант'),
            row(60, 'abc', 0x40, 0x111111, 'Дубль один'),
            row(61, 'abc', 0x40, 0x111111, 'Дубль два'),
        ]
        pairs = pair_rows(english, russian)
        translations, conflicts = translations_from_pairs(pairs)
        self.assertEqual(translations['Engine fault'], 'Ошибка двигателя')
        self.assertNotIn('Same wording', translations)
        self.assertEqual(set(conflicts['Same wording']), {'Ошибка ДМЕ', 'Ошибка КПП'})
        self.assertNotIn('Ambiguous context', translations)
        self.assertNotIn('Unmatched context', translations)

    def test_duplicate_identical_rows_are_safe(self):
        english = [row(1, 'dme', 0x12, 1, 'Fault'), row(2, 'dme', 0x12, 1, 'Fault')]
        russian = [row(10, 'dme', 0x12, 1, 'Ошибка'), row(11, 'dme', 0x12, 1, 'Ошибка')]
        translations, conflicts = translations_from_pairs(pair_rows(english, russian))
        self.assertEqual(translations, {'Fault': 'Ошибка'})
        self.assertEqual(conflicts, {})

    def test_reused_id_with_another_context_is_not_matched(self):
        english = [row(1, 'dme', 0x12, 1, 'Engine fault')]
        russian = [row(1, 'egs', 0x18, 2, 'Ошибка КПП')]
        translations, conflicts = translations_from_pairs(pair_rows(english, russian))
        self.assertEqual(translations, {})
        self.assertEqual(conflicts, {})

    def test_pack_context_translates_changed_english_wording(self):
        pairs = [('Old engine wording', 'Ошибка двигателя', 'label_id', ('dme', 0x12, 0x21f026))]
        tables = {
            'tables/variant/dme.json': {'21F026': 'New engine wording'},
            'tables/addr/12.json': {'21F026': 'New address wording'},
            'tables/codes.json': {'21F026': 'New code wording'},
        }
        translations, conflicts = translations_from_pairs(pack_pairs(pairs, tables))
        self.assertEqual(translations, {
            'New engine wording': 'Ошибка двигателя',
            'New address wording': 'Ошибка двигателя',
            'New code wording': 'Ошибка двигателя',
        })
        self.assertEqual(conflicts, {})

    def test_direct_matches_reject_changed_ids_and_numbers(self):
        for en_id, ru_id, method in ((1, 1, 'label_id'), (2, 20, 'variant_address_code')):
            with self.subTest(method=method):
                english = [row(en_id, 'dme', 0x12, 1, 'Message 0x236 missing, level 2.5')]
                for target in ('Ошибка, уровень 2,5', 'Ошибка 0x234, уровень 2,5',
                               'Ошибка 0x236', 'Ошибка 0x236, уровень 3,5'):
                    russian = [row(ru_id, 'dme', 0x12, 1, target)]
                    self.assertEqual(pair_rows(english, russian), [])
                russian = [row(ru_id, 'dme', 0x12, 1, 'Ошибка 0x0236, уровень 2,5')]
                self.assertEqual([pair[2] for pair in pair_rows(english, russian)], [method])

    def test_pack_context_rejects_changed_ids_and_numbers(self):
        pairs = [('Old wording', 'Ошибка 0x234', 'label_id', ('dme', 0x12, 1))]
        tables = {'tables/variant/dme.json': {
            '000001': 'Message 0x236 missing',
        }}
        self.assertEqual(pack_pairs(pairs, tables), [])
        pairs = [('Old wording', 'Ошибка 0x0236, уровень 2,5', 'label_id', ('dme', 0x12, 1))]
        tables = {'tables/variant/dme.json': {
            '000001': 'Message 0x236 missing, level 2.5',
        }}
        self.assertEqual(len(pack_pairs(pairs, tables)), 1)


if __name__ == '__main__':
    unittest.main()
