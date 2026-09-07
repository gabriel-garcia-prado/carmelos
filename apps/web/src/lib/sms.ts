// iOS and Android disagree on how `sms:` links carry a prefilled body: iOS
// wants `&body=`, everyone else wants `?body=`.
const isIOS = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window)

export const smsHref = (phone: string, body: string): string => {
  const number = phone.replace(/[^\d+]/g, '')
  const separator = isIOS() ? '&' : '?'
  return `sms:${number}${separator}body=${encodeURIComponent(body)}`
}
