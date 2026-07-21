'use client'

import { useEffect } from 'react'
import { setMoneyStyle, type MoneyStyle } from '@/lib/money'

/** Applies the workspace's saved currency style to every money render. */
export function FormatBoot({ currencyFormat }: { currencyFormat: string }) {
  useEffect(() => {
    setMoneyStyle(currencyFormat as MoneyStyle)
  }, [currencyFormat])
  return null
}
