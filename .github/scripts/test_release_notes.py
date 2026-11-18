import os
import subprocess
import tempfile
import unittest
from contextlib import chdir
from pathlib import Path
from unittest.mock import patch

import release_notes as notes

REPO = "promptfoo/promptfoo-action"
PREVIOUS = "promptfoo-action-v1.3.4"
TAG = "promptfoo-action-v1.3.5"
HEADING = (
    f"## [1.3.5](https://github.com/{REPO}/compare/{PREVIOUS}...{TAG}) (2026-11-18)"
)
OLD_HEADING = "## [1.3.4](https://github.com/promptfoo/promptfoo-action/releases/tag/promptfoo-action-v1.3.4)"
ENTRY = f"{HEADING}\n\n### Fixes\n\n- Expand `file://prompts/{{a,b}}.txt`. [#1036](https://github.com/{REPO}/pull/1036)"


class ReleaseNotesTest(unittest.TestCase):
    def test_section_preserves_markdown_and_ignores_example_headings(self):
        example = f"{ENTRY}\n\n~~~markdown\n{OLD_HEADING}\n~~~"
        changelog = f"# Changelog\n\n{example}\n\n{OLD_HEADING}\n"
        self.assertEqual(notes.section(changelog, "1.3.5", REPO), (example, PREVIOUS))
        with self.assertRaisesRegex(ValueError, "heading to link"):
            notes.section(changelog.replace(PREVIOUS + "...", "v1..."), "1.3.5", REPO)

    def test_tags_and_publication_are_verified_on_retry(self):
        with tempfile.TemporaryDirectory() as temp, chdir(temp):

            def git(*args):
                return notes.run("git", *args).strip()

            git("init", "-q", "-b", "main")
            git("config", "user.name", "test")
            git("config", "user.email", "test@example.com")
            git("init", "-q", "--bare", "remote.git")
            git("remote", "add", "origin", "remote.git")
            git("commit", "-q", "--allow-empty", "-m", "1.3.4")
            for tag in (PREVIOUS, "v1", "v1.3"):
                git("tag", "-a", tag, "-m", tag)
            git(
                "commit", "-q", "--allow-empty", "-m", "fix: expand brace globs (#1036)"
            )
            git(
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "chore(deps): js-yaml [security] (#999)",
            )
            Path("CHANGELOG.md").write_text(
                f"# Changelog\n\n{ENTRY}\n\n{OLD_HEADING}\n"
            )
            Path("package.json").write_text('{"version":"1.3.5"}')
            git("add", "CHANGELOG.md", "package.json")
            git("commit", "-qm", "chore(main): release promptfoo-action 1.3.5 (#985)")
            sha = git("rev-parse", "HEAD")
            git("tag", TAG)
            git("push", "-q", "--tags", "origin", "main")
            pr = {
                "number": 985,
                "merged_at": "2026-11-18",
                "merge_commit_sha": sha,
                "base": {"ref": "main"},
                "user": {"login": "github-actions[bot]"},
                "head": {"ref": notes.RELEASE_BRANCH, "repo": {"full_name": REPO}},
            }
            release = {
                "id": 1,
                "draft": False,
                "body": "old PR description",
                "tag_name": TAG,
                "html_url": "https://example.com/release",
            }

            def fake_api(path, body=None, method="POST"):
                if path.endswith("/pulls"):
                    return [pr]
                if body:
                    self.assertEqual(
                        (path, method), (f"repos/{REPO}/releases/1", "PATCH")
                    )
                    release.update(body)
                return release

            with (
                patch.object(notes, "api", side_effect=fake_api),
                patch.object(notes, "comment") as comments,
                patch.dict(os.environ, GITHUB_RUN_ID="123"),
            ):
                notes.publish(REPO, sha, TAG)
                self.assertEqual(release["body"], ENTRY)
                self.assertEqual(
                    notes.coverage(PREVIOUS, sha, ENTRY, REPO),
                    [f"[#999](https://github.com/{REPO}/pull/999)"],
                )
                self.assertIn("actions/runs/123", comments.call_args.args[-1])
                self.assertIn("### Published", comments.call_args.args[-1])
                tags = {tag: notes.remote_tag(tag) for tag in (TAG, "v1", "v1.3")}
                self.assertEqual({peeled for _, peeled in tags.values()}, {sha})
                notes.publish(REPO, sha, "")
                self.assertEqual(tags, {tag: notes.remote_tag(tag) for tag in tags})

                # Replaying an old run must never roll back an alias that has advanced.
                git("commit", "-q", "--allow-empty", "-m", "later release")
                git("tag", "-fa", "v1", "-m", "newer")
                git("push", "-q", "--force", "origin", "refs/tags/v1")
                newer = git("rev-parse", "HEAD")
                with self.assertRaises(subprocess.CalledProcessError):
                    notes.publish(REPO, sha, "")
                self.assertEqual(notes.remote_tag("v1")[1], newer)
                self.assertIn("needs attention", comments.call_args.args[-1])


if __name__ == "__main__":
    unittest.main()
