import {ITaskAssignmentModelTeam} from "./task-assignments-model";

export interface IDailyDigest {
  user_id?: string;
  name?: string;
  greeting?: string;
  note?: string;
  email?: string;
  base_url?: string;
  settings_url?: string;
  recently_assigned?: ITaskAssignmentModelTeam[];
  overdue?: ITaskAssignmentModelTeam[];
  recently_completed?: ITaskAssignmentModelTeam[];
}
