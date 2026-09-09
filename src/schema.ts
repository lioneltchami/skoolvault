import { z } from "zod";

export const UserSchema = z.object({
  id: z.string().default(""),
  name: z.string().default(""),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

export const CommentSchema = z.object({
  id: z.string(),
  parentId: z.string().default(""),
  rootId: z.string().default(""),
  content: z.string().default(""),
  upvotes: z.number().default(0),
  createdAt: z.string().optional(),
  user: UserSchema.optional(),
});

export type Comment = z.infer<typeof CommentSchema>;

export const VideoRefSchema = z.object({
  source: z.enum(["mux", "loom", "vimeo", "youtube", "wistia", "unknown"]),
  playbackId: z.string().optional(),
  url: z.string().optional(),
  durationMs: z.number().optional(),
  localPath: z.string().optional(),
});

export type VideoRef = z.infer<typeof VideoRefSchema>;

export const FileRefSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().default(""),
  url: z.string().optional(),
  localPath: z.string().optional(),
});

export type FileRef = z.infer<typeof FileRefSchema>;

export const LessonSchema = z.object({
  type: z.literal("lesson"),
  id: z.string(),
  courseId: z.string(),
  courseHash: z.string(),
  courseTitle: z.string(),
  section: z.string().default(""),
  title: z.string(),
  position: z.number().default(0),
  content: z.string().default(""),
  url: z.string(),
  videos: z.array(VideoRefSchema).default([]),
  files: z.array(FileRefSchema).default([]),
  comments: z.array(CommentSchema).default([]),
  extractedAt: z.string(),
});

export type Lesson = z.infer<typeof LessonSchema>;

export const CourseSchema = z.object({
  id: z.string(),
  nameHash: z.string(),
  title: z.string(),
  slug: z.string(),
  description: z.string().default(""),
  numModules: z.number().default(0),
  hasAccess: z.boolean().default(true),
});

export type Course = z.infer<typeof CourseSchema>;

export const FeedPostSchema = z.object({
  type: z.literal("feedPost"),
  id: z.string(),
  title: z.string().default(""),
  content: z.string().default(""),
  url: z.string().default(""),
  upvotes: z.number().default(0),
  commentsCount: z.number().default(0),
  createdAt: z.string().optional(),
  user: UserSchema.optional(),
  comments: z.array(CommentSchema).default([]),
  extractedAt: z.string(),
});

export type FeedPost = z.infer<typeof FeedPostSchema>;

export const CommunityMetaSchema = z.object({
  slug: z.string(),
  url: z.string(),
  displayName: z.string().optional(),
  scrapedAt: z.string(),
  skoolvaultVersion: z.string(),
});

export type CommunityMeta = z.infer<typeof CommunityMetaSchema>;
