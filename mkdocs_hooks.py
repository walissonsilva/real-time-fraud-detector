"""Reescreve links que saem de docs/ (código, specs, README raiz) para o GitHub."""

import posixpath
import re

REPO_BLOB = "https://github.com/walissonsilva/real-time-fraud-detector/blob/main/"
LINK = re.compile(r"(\]\()((?:\.\./)+[^)\s#]*)(#[^)\s]*)?(\))")


def on_page_markdown(markdown, page, config, files):
    page_dir = posixpath.dirname(page.file.src_uri)

    def rewrite(match):
        target = posixpath.normpath(posixpath.join(page_dir, match.group(2)))
        if not target.startswith(".."):
            return match.group(0)
        repo_path = posixpath.normpath(posixpath.join("docs", page_dir, match.group(2)))
        return f"{match.group(1)}{REPO_BLOB}{repo_path}{match.group(3) or ''}{match.group(4)}"

    return LINK.sub(rewrite, markdown)
