export type ProjectLanguage= 'java' | 'javascript'|'jsx'|'typescript' | 'tsx';

export interface ProjectFile{
    path: string;
    language: ProjectLanguage;
}
