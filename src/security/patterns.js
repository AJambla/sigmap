'use strict';

/**
 * Secret detection patterns for SigMap scanner.
 * Each pattern has a name and a regex tested against signature strings.
 */
const PATTERNS = [
  {
    name: 'AWS Access Key',
    regex: /AKIA[0-9A-Z]{16}/,
  },
  {
    name: 'AWS Secret Key',
    // 40-char base64-like string following common AWS secret key assignment patterns
    regex: /(?:aws_secret|secret_access_key|SecretAccessKey)\s*[:=]\s*['"]?[0-9a-zA-Z/+]{40}/i,
  },
  {
    name: 'GCP API Key',
    regex: /AIza[0-9A-Za-z\-_]{35}/,
  },
  {
    name: 'GitHub Token',
    regex: /gh[pousr]_[A-Za-z0-9_]{36,}/,
  },
  {
    name: 'JWT Token',
    regex: /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/,
  },
  {
    name: 'DB Connection String',
    regex: /(mongodb|postgres|postgresql|mysql|redis):\/\/[^:]+:[^@]+@/i,
  },
  {
    name: 'SSH Private Key',
    regex: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  {
    name: 'Stripe Key',
    regex: /sk_(live|test)_[0-9a-zA-Z]{24,}/,
  },
  // The `sk-` family (#771). `sk_live_`/`sk_test_` above uses an UNDERSCORE;
  // OpenAI and Anthropic use a HYPHEN, so the Stripe pattern never covered
  // them and five of seven credential shapes passed through untouched. The
  // leading `\b` matters: without it `sk-` matches inside `risk-…`.
  // Anthropic and the OpenAI project form come first — both contain hyphens
  // after `sk-`, so the legacy alphanumeric-only pattern cannot claim them,
  // but ordering keeps the reported name right if either format widens.
  {
    name: 'Anthropic API Key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  },
  {
    name: 'OpenAI API Key',
    regex: /\bsk-proj-[A-Za-z0-9_-]{20,}/,
  },
  {
    name: 'OpenAI API Key (legacy)',
    regex: /\bsk-[A-Za-z0-9]{32,}/,
  },
  {
    name: 'Slack Token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    name: 'Slack Webhook',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/,
  },
  {
    name: 'Twilio Key',
    regex: /SK[0-9a-fA-F]{32}/,
  },
  {
    name: 'Generic Secret',
    regex: /(secret|password|passwd|api_key|apikey|auth_token|access_token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  },
  {
    name: 'Generic Secret',
    // Unquoted values — `.env` / YAML / CLI shapes (`password=…`, `api_key: …`)
    // that the quoted pattern above misses (#668). Marked textOnly because an
    // unquoted value token is indistinguishable from a type annotation
    // (`password: PasswordHasher`), and the signature scanner would replace
    // the whole declaration; `sigmap redact` runs over real config/log text
    // where the aggressive match is exactly right (#680).
    textOnly: true,
    regex: /(secret|password|passwd|api_key|apikey|auth_token|access_token)\s*[:=]\s*[^\s'"]{8,}/i,
  },
];

module.exports = { PATTERNS };
