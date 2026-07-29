import { redirect } from 'next/navigation'

/** The ambassadors moved out of Settings and up to their own page. */
export default function AmbassadorsMoved() {
  redirect('/ambassadors')
}
