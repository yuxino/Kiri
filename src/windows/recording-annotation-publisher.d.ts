import type {AnnotationMark} from "../annotation/model";
export interface RecordingInkFrame {marks: AnnotationMark[]; canUndo: boolean; canRedo: boolean; hasMarks: boolean}
export class RecordingAnnotationPublisher {
  constructor(send: (revision: number, value: RecordingInkFrame) => Promise<void>, onError: (failed: boolean) => void);
  revision: number;
  push(value: RecordingInkFrame): void;
  drain(): Promise<number>;
  dispose(): void;
}
export function recordingInkMarks(marks: AnnotationMark[], draft: AnnotationMark | null): AnnotationMark[];
