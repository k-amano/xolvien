import { createContext, useContext, useState } from 'react'
import { ja } from './ja'
import { en } from './en'
import { getErrorCatalog, type ErrorCopy } from './errorCatalog'
import type { ErrorCode } from '../errors'

export type Lang = 'ja' | 'en'

// Use a structural type that allows both ja and en to satisfy the interface
export type Translations = {
  [K in keyof typeof ja]: typeof ja[K] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : string
}

export const translations: Record<Lang, Translations> = { ja, en }

interface LangContextType {
  lang: Lang
  t: Translations
  errorCatalog: Record<ErrorCode, ErrorCopy>
  setLang: (lang: Lang) => void
}

export const LangContext = createContext<LangContextType>({
  lang: 'ja',
  t: ja,
  errorCatalog: getErrorCatalog('ja'),
  setLang: () => {},
})

export function useLang() {
  return useContext(LangContext)
}

export function useLangState(): LangContextType {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem('xolvien-lang')
    return (saved === 'en' || saved === 'ja') ? saved : 'ja'
  })
  const t = translations[lang]
  const errorCatalog = getErrorCatalog(lang)
  const setLang = (l: Lang) => {
    setLangState(l)
    localStorage.setItem('xolvien-lang', l)
  }
  return { lang, t, errorCatalog, setLang }
}
