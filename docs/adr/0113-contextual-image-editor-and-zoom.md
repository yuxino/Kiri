# ADR 0113: Contextual image editing and independent view zoom

Status: Accepted

## Context

Fitting every saved image into the window makes long screenshots unreadable.
A fixed-height properties strip also consumes picture space when no annotation
is selected. The saved-image editor should use the same object selection and
annotation controls as capture.

## Decision

- Keep the existing compact annotation toolbar. Show a bounded floating options
  panel only for the current tool, selected object, or pending crop. Empty Select
  has no properties panel. The options button hides/reopens it; choosing a tool
  or a different object shows the corresponding controls. Opening options does
  not resize or reposition the image.
- Long images open at a readable width, capped at original pixel density; ordinary
  images initially fit. A compact view bar offers zoom, fit width, fit image,
  and actual size. At 100%, one source pixel maps to one device pixel.
- Wheel/trackpad scrolling moves the image. Pinch or Ctrl/Command-wheel zooms
  around the pointer. Space-drag or middle-drag pans. Ctrl/Command +/− zooms,
  0 fits the image, and 1 restores actual size. Native text inputs retain their
  own keys and composition. Active drawing/cropping gestures hold view geometry.
- View changes affect neither annotation coordinates, dirty state, crop pixels,
  nor exported resolution. Zoom anchors retain the same source point; resizing
  and display-density changes preserve the current image center.
- Only the visible canvas region (plus small overscan) is allocated. Full-image
  bounds remain the basis for pointer mapping and inline text layout. Original
  pixel export and the existing layered-mosaic composition remain unchanged.
- Scrolling-capture previews retain their current decoded image while a second
  buffer loads. Image pixels, geometry and follow position swap together after
  decode; outdated async results cannot replace a newer presentation. Decode
  failure retains the last good image. Inspecting the preview holds its position.

## Verification boundary

Geometry and component tests cover source anchoring, canvas clipping, annotation
editing/export, delayed preview decode and out-of-order image completion.
Browser layout checks and the stable-signed macOS app complement those tests;
physical trackpad feel and Windows/Linux device acceptance remain separate.
