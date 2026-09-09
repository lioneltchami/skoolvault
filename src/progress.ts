import { readJson, writeJson } from "./storage.js";

export type LessonProgressStatus =
	| "pending"
	| "complete"
	| "partial"
	| "skipped";

export interface ProgressState {
	courses: Record<
		string,
		{
			status: "pending" | "complete";
			lessons: Record<string, LessonProgressStatus>;
		}
	>;
	feed: {
		status: "pending" | "complete";
		posts: Record<string, "pending" | "complete">;
	};
	videos: Record<string, "pending" | "complete" | "failed">;
	updatedAt: string;
}

export function emptyProgress(): ProgressState {
	return {
		courses: {},
		feed: { status: "pending", posts: {} },
		videos: {},
		updatedAt: new Date().toISOString(),
	};
}

export function loadProgress(file: string): ProgressState {
	return readJson<ProgressState>(file) ?? emptyProgress();
}

export function saveProgress(file: string, state: ProgressState): void {
	state.updatedAt = new Date().toISOString();
	writeJson(file, state);
}

export function isLessonDone(
	state: ProgressState,
	courseSlug: string,
	lessonId: string,
): boolean {
	return state.courses[courseSlug]?.lessons[lessonId] === "complete";
}

export function markLessonDone(
	state: ProgressState,
	courseSlug: string,
	lessonId: string,
): void {
	if (!state.courses[courseSlug]) {
		state.courses[courseSlug] = { status: "pending", lessons: {} };
	}
	state.courses[courseSlug].lessons[lessonId] = "complete";
}

/** Lesson scraped but requested media failed — resume should retry. */
export function markLessonPartial(
	state: ProgressState,
	courseSlug: string,
	lessonId: string,
): void {
	if (!state.courses[courseSlug]) {
		state.courses[courseSlug] = { status: "pending", lessons: {} };
	}
	state.courses[courseSlug].lessons[lessonId] = "partial";
}

export function markCourseDone(state: ProgressState, courseSlug: string): void {
	if (!state.courses[courseSlug]) {
		state.courses[courseSlug] = { status: "complete", lessons: {} };
	} else {
		state.courses[courseSlug].status = "complete";
	}
}

export function isVideoDone(state: ProgressState, key: string): boolean {
	return state.videos[key] === "complete";
}

export function isVideoFailed(state: ProgressState, key: string): boolean {
	return state.videos[key] === "failed";
}

export function markVideo(
	state: ProgressState,
	key: string,
	status: "complete" | "failed",
): void {
	state.videos[key] = status;
}
