## [1.1.2]

- Added a command-palette fallback to review a copied Git commit hash when the SCM history menu proposal is unavailable
- Enabled the SCM history menu proposal in the extension development host
- Moved "Review File in Commit with Copilot" from the commit menu to the history-change file menu
- Review File now reviews only the file selected in the SCM graph without opening a file picker

## [1.1.1]

- Added "Review Section with Copilot" to SVN SCM section headers (Changes / Unversioned / Remote Changes)
- Added section-aware SVN collection commands so local, unversioned, and remote changes can be reviewed in one batch

## [1.1.0]

- Added a feature that allows reviewing commits individually from the graph section of the Git history

## [1.0.10]

- Added "Review Changed Files" to the GitHub Pull Request panel's Changed Files header
- Added the PR panel action as a separate command without replacing the built-in "Code Review" button

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
