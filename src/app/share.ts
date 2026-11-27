import { Share } from 'react-native';

/** The phone's own share sheet, with `text` as its message (slice 2.3: the payment list). Nothing is written to a file,
 * a log or the record; the text is the sheet's alone once handed over. */
export async function shareText(title: string, text: string): Promise<void> {
  await Share.share({ title, message: text });
}
