import { formatMoney } from '@/lib/money'

export function Money({ minor, currency, className = '' }: { minor: number; currency: string; className?: string }) {
  const negative = minor < 0
  return (
    <span className={`${negative ? 'text-red-600' : ''} ${className}`}>{formatMoney(minor, currency)}</span>
  )
}

export function Percent({ value, className = '' }: { value: number; className?: string }) {
  const negative = value < 0
  return (
    <span className={`${negative ? 'text-red-600' : ''} ${className}`}>
      {(value * 100).toFixed(1)}%
    </span>
  )
}
