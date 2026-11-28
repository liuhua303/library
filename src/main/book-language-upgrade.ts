import { inspectEpub } from './epub';
import type { ReaderStore } from './store';

export interface LanguageUpgradeSummary {
  checked: number;
  updated: number;
  skipped: number;
  failed: number;
}

/** Correct pre-language imports without changing saved collections or making model requests. */
export async function upgradeLegacyBookLanguages(store: ReaderStore): Promise<LanguageUpgradeSummary> {
  const summary: LanguageUpgradeSummary = { checked: 0, updated: 0, skipped: 0, failed: 0 };
  for (const book of store.listBooks()) {
    if (book.languageSource !== 'legacy') continue;
    summary.checked++;
    try {
      const detection = await inspectEpub(store.readBook(book.id));
      const reconciled = store.reconcileBookLanguage(book.id, detection);
      if (reconciled.language !== book.language || reconciled.languageSource !== book.languageSource) summary.updated++;
      else summary.skipped++;
    } catch {
      // A missing or unsupported old archive must not prevent the rest of the library from opening.
      summary.failed++;
    }
  }
  return summary;
}
