# ADR 0078: Cancellable GIF conversion and video validation

Status: Accepted

## Decision

Saved-video GIF conversion exposes Cancel in Library feedback and the completion
card. Cancellation is cooperative: checking and encoding stop between native
frames, temporary output is removed, the original MP4 remains unchanged, and
cancellation does not appear as a conversion failure. Retry remains unavailable
until native work has actually stopped. Once library import begins atomically,
Cancel is disabled and the completed GIF is saved.

Before encoding, run a decode-only pass over the frames used by the GIF. This
adds decoding work to healthy conversions, but catches decoding failures before
paying the much larger cost of GIF palette encoding. Show checking and encoding
as separate stages. Decode validation cannot predict later disk errors or changes
to an external source file; those failures still retain their operation reason.

On macOS, sample the video track's time range, including its start offset, rather
than the asset's total audiovisual duration. A longer audio tail is irrelevant
to a silent GIF and must not cause requests beyond the final video frame.

## Verification

Cover cancellation during checking and encoding, cancellation racing library
commit, restart after cancellation, frontend progress and button states, and a
native MP4 whose audio track extends beyond its video track. Keep original user
media outside the repository.
