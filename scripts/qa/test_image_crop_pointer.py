"""Check crop QA input preparation without a browser or desktop session."""
import ast
from pathlib import Path
import struct
from types import SimpleNamespace
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'docs/demos/full-flow/test_image_crop.py'
TREE = ast.parse(SOURCE.read_text(), filename=str(SOURCE))
HELPER = next(node for node in TREE.body
              if isinstance(node, ast.AsyncFunctionDef) and node.name == 'drag_image_document')
NAMESPACE = {}
exec(compile(ast.Module(body=[HELPER], type_ignores=[]), str(SOURCE), 'exec'), NAMESPACE)
drag = NAMESPACE['drag_image_document']


class Image:
    def __init__(self, boxes, events, covered=False):
        self.boxes = iter(boxes)
        self.events = events
        self.covered = covered

    async def hover(self, **options):
        self.events.append(('hover', options))
        if self.covered:
            raise TimeoutError('Image is covered by another control')

    async def bounding_box(self):
        box = next(self.boxes)
        self.events.append(('geometry', box))
        return box


class Mouse:
    def __init__(self, events, fail_move=False):
        self.events = events
        self.fail_move = fail_move

    async def down(self):
        self.events.append(('down',))

    async def move(self, x, y, **options):
        self.events.append(('move', x, y, options))
        if self.fail_move and options.get('steps') == 8:
            raise RuntimeError('Pointer transport failed')

    async def up(self):
        self.events.append(('up',))


class CropPointerPreparation(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.events = []
        self.page = SimpleNamespace(mouse=Mouse(self.events))
        # Nonzero offsets model the editor inside its parent document/iframe.
        self.box = {'x': 25.25, 'y': 97.5, 'width': 750, 'height': 450}

    async def test_edge_handle_starts_inside_but_destination_keeps_document_coordinates(self):
        await drag(self.page, Image([self.box, self.box], self.events), (0, 0), (50, 40))
        self.assertEqual([event for event in self.events if event[0] == 'hover'],
                         [('hover', {'trial': True}), ('hover', {'position': {'x': 2, 'y': 2}})])
        self.assertEqual(self.events[-4:], [('move', 27.25, 99.5, {}), ('down',), ('move', 100.25, 157.5, {'steps': 8}), ('up',)])

    async def test_toolbar_reflow_reprepares_without_sending_a_partial_drag(self):
        previous = {'x': 12, 'y': 81, 'width': 776, 'height': 465.6}
        await drag(self.page, Image([previous, self.box, self.box, self.box], self.events), (80, 60), (160, 110))
        self.assertEqual([event[1]['position'] for event in self.events
                          if event[0] == 'hover' and 'position' in event[1]],
                         [{'x': 124.16, 'y': 93.12}, {'x': 120, 'y': 90}])
        self.assertEqual(self.events[-4:], [('move', 145.25, 187.5, {}), ('down',), ('move', 265.25, 262.5, {'steps': 8}), ('up',)])
        self.assertEqual(sum(event[0] == 'down' for event in self.events), 1)
        self.assertEqual(sum(event[0] == 'geometry' for event in self.events[:-3]), 4)

    async def test_fractional_scale_annotation_starts_at_untruncated_document_point(self):
        # The 1.5x CI fixture's CSS-quantized frame reproduces the observed
        # rectangle error exactly when locator hover's 0.01px point is reused.
        box = {'x': 66.65625, 'y': 100, 'width': 666.65625, 'height': 400}
        await drag(self.page, Image([box, box], self.events), (80, 60), (160, 110))
        pressed_at = next(index for index, event in enumerate(self.events) if event[0] == 'down')
        start = self.events[pressed_at - 1]
        end = self.events[pressed_at + 1]
        self.assertEqual(start, ('move', 173.32125000000002, 180, {}))
        # Chromium reports these pointer coordinates with float32 precision.
        f32 = lambda value: struct.unpack('f', struct.pack('f', value))[0]
        document_x = lambda screen_x: (f32(screen_x) - box['x']) * 500 / box['width']
        rounded_x = document_x(int(start[1] * 100) / 100)
        self.assertAlmostEqual(rounded_x - 50, 29.999067978601232, places=12)
        self.assertAlmostEqual(document_x(end[1]) - rounded_x, 80.00092195044064, places=12)
        self.assertGreater(abs(rounded_x - 80), 0.0001)
        precise_x, precise_end = document_x(start[1]), document_x(end[1])
        self.assertLess(abs(precise_x - 80), 0.0001)
        self.assertLess(abs((precise_end - precise_x) - 80), 0.0001)

    async def test_continuously_moving_image_fails_before_any_mouse_press(self):
        changed = {**self.box, 'x': self.box['x'] + 1}
        with self.assertRaisesRegex(AssertionError, 'did not settle'):
            await drag(self.page, Image([self.box, changed] * 5, self.events), (0, 0), (50, 40))
        self.assertFalse(any(event[0] in ('down', 'move', 'up') for event in self.events))

    async def test_covered_image_failure_is_not_retried_or_ignored(self):
        with self.assertRaisesRegex(TimeoutError, 'covered'):
            await drag(self.page, Image([], self.events, covered=True), (0, 0), (50, 40))
        self.assertEqual(self.events, [('hover', {'trial': True})])

    async def test_disappeared_image_fails_before_mouse_press(self):
        with self.assertRaisesRegex(AssertionError, 'no usable pointer geometry'):
            await drag(self.page, Image([None], self.events), (0, 0), (50, 40))
        self.assertFalse(any(event[0] == 'down' for event in self.events))

    async def test_failed_pointer_move_releases_the_mouse(self):
        self.page.mouse.fail_move = True
        with self.assertRaisesRegex(RuntimeError, 'Pointer transport failed'):
            await drag(self.page, Image([self.box, self.box], self.events), (0, 0), (50, 40))
        self.assertEqual(self.events[-1], ('up',))


if __name__ == '__main__':
    unittest.main()
