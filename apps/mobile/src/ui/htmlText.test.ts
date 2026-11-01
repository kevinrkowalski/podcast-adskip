/// <reference types="jest" />
import { htmlToPlainText } from './htmlText';

test('paragraphs and list items become readable lines', () => {
  expect(htmlToPlainText('<p>One</p><p>Two<br/>Three</p><ul><li>A</li><li>B</li></ul>')).toBe(
    'One\n\nTwo\nThree\n\n• A\n\n• B',
  );
});

test('entities decode once', () => {
  expect(htmlToPlainText('Tom &amp; Jerry &lt;3 &#8217; &amp;lt;tag&amp;gt;')).toBe('Tom & Jerry <3 ’ &lt;tag&gt;');
});

test('empty input gives empty text', () => {
  expect(htmlToPlainText(undefined)).toBe('');
  expect(htmlToPlainText('<p> </p>')).toBe('');
});

test('a tag cut off by truncation is dropped, but a literal "<" in text stays', () => {
  expect(htmlToPlainText('<p>Hosted by Sam. Find us at <a href="https://exa')).toBe('Hosted by Sam. Find us at');
  expect(htmlToPlainText('Scores: 3 < 5')).toBe('Scores: 3 < 5');
});
