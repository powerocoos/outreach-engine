"""Turn verified audit findings into short on-screen captions for the recording.

Captions are derived ONLY from the findings list, so the video can never claim
something the audit did not verify. Matching is on the finding text produced by audit.build_findings.
"""
import re

MAX_CAPTIONS = 3

# (keyword found in finding, caption builder). Order = priority (most customer-relevant first).
RULES = [
    ("tap-to-call", lambda f: "No tap-to-call button on the homepage"),
    ("performance score of", lambda f: f"Google mobile speed score: {re.search(r'(\d+)/100', f).group(1)}/100"),
    ("seconds to appear", lambda f: f"Main content takes ~{re.search(r'about ([\d.]+) seconds', f).group(1)}s to appear"),
    ("viewport", lambda f: "Not built for phones: desktop page shrunk to fit"),
    ("HTTPS", lambda f: "Browser warns visitors: 'Not secure'"),
]


def captions_for(findings):
    out = []
    for keyword, build in RULES:
        for f in findings:
            if keyword in f:
                try:
                    out.append(build(f))
                except (AttributeError, IndexError):
                    out.append(None)
                break
    return [c for c in out if c][:MAX_CAPTIONS]


# Injected into the page being recorded. Fixed-position, so it never shifts page layout.
OVERLAY_JS = """
(text) => {
  let el = document.getElementById('__rpd_caption');
  if (!el) {
    el = document.createElement('div');
    el.id = '__rpd_caption';
    el.setAttribute('style', [
      'position:fixed','left:12px','right:12px','top:12px','z-index:2147483647',
      'padding:12px 16px','border-radius:10px','background:rgba(17,17,17,.92)','color:#fff',
      'font:700 18px/1.3 system-ui,-apple-system,sans-serif','text-align:center',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)','pointer-events:none'
    ].join(';'));
    document.documentElement.appendChild(el);
  }
  el.textContent = text;
}
"""
