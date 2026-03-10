## [1.0.7]

- Improved review support for files shown in SVN Remote Changes

## [1.0.6]

- Added "Review Section with Copilot" to Git SCM section headers (Changes / Staged Changes)
- Added command-based batch review prompt for Git sections — Copilot executes `git -C "<repo>" diff` / `git -C "<repo>" diff --cached` to collect diffs

## [1.0.5]

- Added "Review Commit with Copilot" to SVN REPOSITORIES view commit rows — Copilot executes `svn diff -c` itself, bypassing the 50KB diff size limit
- Added "Add to Review List" to accumulate multiple SVN commits for batch review (duplicate revisions are automatically ignored)
- Added "Review Multi Commit with Copilot" to review all accumulated commits together in one request — revisions are sent in ascending order regardless of the order added

## [1.0.4]

- Added "Review with Copilot" to SVN FILE HISTORY and REPOSITORIES views (svn-scm extension)
- Added support for Remote Changes in SVN SCM view

## [1.0.2]

- First release