export interface Board {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pageCount?: number;
}
export interface Page {
  id: string;
  boardId: string;
  name: string;
  position: number;
  createdAt: number;
}
export interface PageList<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
export interface BoardDetails {
  board: Board;
  isOwner: boolean;
}
export const SCHEMA_VERSION = 1;
