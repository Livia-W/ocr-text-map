# A handoff — 20261105.2

Only A is changed. B OCR and C gestures are outside this delivery.

Serve this directory over HTTPS on iPhone (localhost suffices on desktop).
Open index.html normally or c-interface-test.html for the standalone C interface exercise.
The test embeds A in a same-origin iframe. Start camera and collect a page there, then Subscribe.

## Video API

window.BookReader.getVideoElement() returns the existing HTMLVideoElement.
getVideoInfo() returns video, width/height (intrinsic pixels), coordinateSpace=currentVideo,
units=pixels, origin=top-left, xDirection=right, yDirection=down, mirrored=false.
subscribeVideoFrames(callback) returns an unsubscribe function. Messages have type=frame,
video, dimensions, timestamp (performance.now milliseconds), mediaTime (video seconds),
frameNumber (monotonic bridge count). RAF fallback emits only when currentTime changes;
it is not guaranteed to expose every decoded camera frame. The element is live, not an
immutable frame snapshot: copy synchronously if retaining pixels. Async subscribers receive
no concurrent callbacks; frames while busy are dropped without queuing.
State messages have type=state, state=stopped/background/reference-changing or tracking-error,
timestamp and frameNumber. Camera stop is observed on the next animation tick; background
notification is also immediate from visibilitychange. An unsubscribed pending callback is skipped.
No additional getUserMedia call is made. Photo capture leaves this stream active.

## Reference tracking

subscribePageTracking(callback) returns unsubscribe. Envelope: timestamp, frameNumber, pages.
Each page: pageId, referenceCaptureCount, timestamp, frameNumber, referenceSize, videoSize,
units=pixels, pointOrder=TL,TR,BR,BL, matrixDirection=reference-to-currentVideo,
valid, reason, referenceToCurrentVideo/currentVideoToReference (row-major 3x3).
Valid records also contain corners (current video pixels), quality.features/matches/inliers/inlierRatio.
Apply H to [x,y,1] and divide by the third component. Reference coordinates refer to the
rectified single-page JPEG. Invalid matrices are null. Lifecycle invalidations contain only
pageId, valid=false, reason and null matrices; do not expect geometry on these messages.

Implementation: original captured image is downsampled to 640px width; reference interior
corners are measured by goodFeaturesToTrack, matched to current frame by pyramidal LK,
then fitted by RANSAC homography. At least 12 matches/inliers and 70% inlier ratio required.
Reference pixels are composed through inverse original-to-page matrix and analysis scaling.
Each pass matches against the original reference, so no old matrix is returned as valid on
failure. New capture replaces tracking references with pages in that capture. Tracking does
not cover historical pages absent from the latest capture. Matrix estimates are planar only.

Limitations: wide moves may exceed LK convergence; repetitive text can create false matches.
Occlusion and visually similar page turns need device testing; this is not a semantic page-turn
proof. Tracking runs synchronously on the main thread at most about 8Hz and may affect A's
latency. No optical-flow boundary update is claimed in page-detector.track(): that method now
runs actual full detection. References are decoded asynchronously; no tracking is available
until decoding completes. Subscribers should hide markers on invalid or stale (>400ms) data.

## B events (unchanged)

bookreader:captured detail: blob (full original JPEG), width, height, pages, metadata.
Each pages entry: blob (rectified page JPEG), pageId, label, width, height, points, matrix,
evidence. points are original-image pixel TL/TR/BR/BL. matrix maps original pixels to page
pixels. metadata: version=2, captureCount, pageIds, coordinateSpace=original-image-pixels,
pointOrder, matrixDirection=original-to-page, original dimensions, pages without blobs,
curvedSurfaceCorrected=false. pageIds correspond to the output pages.
bookreader:page-updated is emitted only for newly committed references; detail: pageId,
referenceImage (rectified Blob), label, points, matrix, width, height, captureCount, automatic.
No OCR, reading order, or speech logic is added. Existing references and dedup remain in A.

## Verification

Automated: existing node --test tests/*.test.cjs suite and JavaScript syntax checks.
These do not validate real LK motion accuracy or iPhone rendering. No new iPhone test performed.

Manual pending: subscribe and observe increasing frame numbers/timestamps; collect a page and
verify frame delivery continues; move/rotate the book slightly and verify the red center stays
on paper; remove/turn book and require marker disappearance and invalid tracking; cancel and
verify callback count stops; stop camera/background and verify lifecycle notification.
The user reports earlier A camera/capture/stability/page-update device checks; those are not
new verification of this delivery.

## Recording failure investigation — build 20261105.3

Saved input: tests/fixtures/recording-01.png (recording near 0.5s), cropped A video
x=166,y=412,w=264,h=460 and resized to 360x640: failure-analysis.png/.rgba.
This is screen-recorded displayed video, not lossless original camera pixels. UI overlays
and recording compression are limitations. Reproduce: node reproduce-failure.cjs output.json.
Before/after reports: tests/fixtures/failure-before.json and failure-after.json.
Before: 61 contours, 2 area-passed, 0 quads; luminance component joins desk (71.15%).
After: neutral-paper proposal separates 37.97% paper component. Rightmost corner x=356/360
is still too close to image edge; correctly rejected as incomplete. This is not a successful
capture fixture. Whole-page capture still requires all four paper edges in the video.
Paper-colour proposals still pass existing geometry/text checks; no bounding rectangle
fallback or geometry threshold expansion. Coloured pages may rely on original contour paths.
Debug panel suppresses small-contour lines and lists largest 16 significant candidates.
C test preview draws at <=480px width and <=8Hz; cancel freezes it with explicit Chinese label.
New automated tests cover the recording crop rejection, a complete paper on bright connected
desk, and C preview refresh/downsampling/cancellation with mocked video callbacks.
Device acceptance and the top preview on iPhone are still pending; no new iPhone test claimed.
