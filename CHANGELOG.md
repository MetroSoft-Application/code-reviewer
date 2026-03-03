## [1.0.5]

- Added "Review Commit with Copilot" to SVN REPOSITORIES view commit rows — Copilot executes `svn diff -c` itself, bypassing the 50KB diff size limit
- Added "Add to Review List" to accumulate multiple SVN commits for batch review (duplicate revisions are automatically ignored)
- Added "Review Multi Commit with Copilot" to review all accumulated commits together in one request — revisions are sent in ascending order regardless of the order added

## [1.0.4]

- Added "Review with Copilot" to SVN FILE HISTORY and REPOSITORIES views (svn-scm extension)
- Added support for Remote Changes in SVN SCM view

## [1.0.2]

- First release