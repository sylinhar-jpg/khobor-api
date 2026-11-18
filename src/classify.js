'use strict';
// Transparent Halal filter: plain keyword rules, no hidden scoring.
// A story is flagged when its title, summary or text contains one of these words.
// An editor can override any story (haram_override), and a poster can mark their own post.
// This is an automatic content filter, not a religious ruling.

const RULES = [
  {
    group: 'alcohol',
    label: 'মদ / অ্যালকোহল',
    terms: ['মদ', 'মদপান', 'মদ্যপান', 'মদ্যপ', 'অ্যালকোহল', 'বিয়ার', 'ওয়াইন', 'হুইস্কি', 'বারে মদ', 'alcohol', 'beer', 'wine', 'whisky', 'whiskey', 'liquor', 'vodka'],
  },
  {
    group: 'gambling',
    label: 'জুয়া / বাজি',
    terms: ['জুয়া', 'জুয়াড়ি', 'ক্যাসিনো', 'বেটিং', 'অনলাইন বাজি', 'লটারি', 'gambling', 'casino', 'betting', 'lottery', 'jackpot'],
  },
  {
    group: 'obscene',
    label: 'অশ্লীলতা',
    terms: ['অশ্লীল', 'পর্নো', 'পর্ন', 'নগ্ন', 'porn', 'nude', 'obscene', 'adult film'],
  },
  {
    group: 'pork',
    label: 'শূকরের মাংস',
    terms: ['শূকরের মাংস', 'pork', 'bacon'],
  },
];

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A term matches as a whole word, optionally followed by a common Bengali ending,
// so "মদের" matches "মদ" but "মদিনা" and "আতশবাজি" do not.
const ENDINGS = ['', 'ের', 'র', 'ে', 'য়', 'তে', 'কে', 'টি', 'টা', 'গুলো', 'গুলি', 'সহ', 'ও', 'ই', 'দের', 'রা', 'ী', 'ির', 'ীর', 's'];
const ENDING_RE = '(?:' + ENDINGS.map((e) => esc(e.normalize('NFC'))).filter(Boolean).join('|') + ')?';
const COMPILED = RULES.map((r) => ({
  ...r,
  re: r.terms.map((t) => ({ t, re: new RegExp('(?<![\\p{L}\\p{M}])' + esc(t.normalize('NFC')) + ENDING_RE + '(?![\\p{L}\\p{M}])', 'iu') })),
}));

function classify(...texts) {
  const hay = texts.filter(Boolean).join('\n').normalize('NFC');
  const terms = [];
  const groups = [];
  for (const r of COMPILED) {
    for (const { t, re } of r.re) {
      if (re.test(hay)) {
        terms.push(t);
        if (!groups.includes(r.group)) groups.push(r.group);
      }
    }
  }
  return { is_haram: terms.length > 0, terms, groups };
}

function publicRules() {
  return {
    method: 'keyword',
    note: 'Stories are flagged automatically when they contain one of these words. This is a content filter, not a religious ruling. Editors can correct any story.',
    note_bn: 'এই শব্দগুলোর কোনোটি থাকলে সংবাদটি স্বয়ংক্রিয়ভাবে চিহ্নিত হয়। এটি একটি কনটেন্ট ফিল্টার, কোনো ধর্মীয় ফতোয়া নয়। সম্পাদক যেকোনো সংবাদ সংশোধন করতে পারেন।',
    rules: RULES.map(({ group, label, terms }) => ({ group, label, terms })),
  };
}

module.exports = { classify, publicRules, RULES };
