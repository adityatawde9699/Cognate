//! Atomic operation admission. Failed/malformed/colliding batches commit nothing.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Connection, Row, SqliteConnection};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Timestamp { wall: i64, counter: i64, actor: String }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Operation {
    #[serde(rename = "set")]
    Set { id: String, hlc: Timestamp, entity: String, field: String, value: Value },
    #[serde(rename = "del")]
    Delete { id: String, hlc: Timestamp, entity: String },
}
fn token(s: &str, max: usize) -> bool { !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control) }
fn json_valid(value: &Value, depth: usize) -> bool {
    if depth > 32 { return false; }
    match value {
        Value::Array(items) => items.iter().all(|v| json_valid(v, depth + 1)),
        Value::Object(items) => items.iter().all(|(k,v)| !["__proto__", "constructor", "prototype"].contains(&k.as_str()) && json_valid(v, depth + 1)),
        _ => true,
    }
}
impl Operation {
    fn parts(&self) -> (&str, &Timestamp, &str, Option<&str>, Option<&Value>) {
        match self {
            Self::Set { id, hlc, entity, field, value } => (id, hlc, entity, Some(field), Some(value)),
            Self::Delete { id, hlc, entity } => (id, hlc, entity, None, None),
        }
    }
    fn validate(&self) -> Result<(), String> {
        let (id, hlc, entity, field, value) = self.parts();
        if !token(id,4096) || !token(entity,512) || !token(&hlc.actor,512) ||
            hlc.wall < 0 || hlc.counter < 0 || hlc.wall > 9_007_199_254_740_991 || hlc.counter > 9_007_199_254_740_991 {
            return Err("Malformed operation identity or clock".into());
        }
        if field.is_some_and(|f| !token(f,128) || ["__proto__","constructor","prototype"].contains(&f)) ||
            value.is_some_and(|v| !json_valid(v,0)) || serde_json::to_vec(self).map_err(|e|e.to_string())?.len() > 65_536 {
            return Err("Invalid/oversized operation value".into());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
pub struct HistoryPrecondition { tasks: Vec<Value>, projects: Vec<Value>, ops: Vec<Operation> }

pub(crate) async fn current_rows(db: &mut SqliteConnection, table: &str) -> Result<Vec<Value>, String> {
    let fields: &[&str] = if table == "tasks" { &[
        "id","title","description","deadline","tags","importance","effort","priority","done","created_at","completed_at",
        "pomodoros_spent","project_id","parent_id","milestone_id","recurrence","sort_order","custom_fields","deleted_at",
        "duration_min","energy","pinned","scheduled_start","scheduled_end","min_block","max_block",
    ] } else { &["id","name","color","created_at","sort_order"] };
    let args = fields.iter().map(|field| {
        let expression = match *field {
            "done"|"pinned" => format!("json(CASE WHEN {field}=0 THEN 'false' ELSE 'true' END)"),
            "tags"|"custom_fields" => format!("json({field})"),
            _ => field.to_string(),
        };
        format!("'{field}',{expression}")
    }).collect::<Vec<_>>().join(",");
    let rows: Vec<String> = sqlx::query_scalar(&format!("SELECT json_object({args}) FROM {table} ORDER BY id"))
        .fetch_all(db).await.map_err(|e| e.to_string())?;
    rows.into_iter().map(|row| serde_json::from_str(&row).map_err(|e|e.to_string())).collect()
}

fn same_rows(mut expected: Vec<Value>, mut current: Vec<Value>) -> bool {
    expected.sort_by_key(|row| row["id"].as_str().unwrap_or_default().to_string());
    current.sort_by_key(|row| row["id"].as_str().unwrap_or_default().to_string());
    expected == current
}

#[cfg(test)]
pub async fn append(connection: &mut SqliteConnection, ops: &[Operation]) -> Result<(), String> {
    append_checked(connection,ops,None).await
}

async fn append_checked(connection: &mut SqliteConnection, ops: &[Operation], expected: Option<HistoryPrecondition>) -> Result<(), String> {
    if ops.len() > 50_000 { return Err("Operation batch exceeds limit".into()); }
    for op in ops { op.validate()?; }
    let mut transaction = connection.begin().await.map_err(|e|e.to_string())?;
    if let Some(expected) = expected {
        if !same_rows(expected.tasks, current_rows(&mut transaction,"tasks").await?) ||
            !same_rows(expected.projects,current_rows(&mut transaction,"projects").await?) {
            return Err("Local rows changed since the audit. Export a fresh audit before repairing.".into());
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM oplog").fetch_one(&mut *transaction).await.map_err(|e|e.to_string())?;
        if count as usize != expected.ops.len() { return Err("Operation history changed since the audit".into()); }
        for op in expected.ops {
            let (id, hlc, entity, field, value) = op.parts();
            let previous = sqlx::query("SELECT * FROM oplog WHERE id=?")
                .bind(id).fetch_optional(&mut *transaction).await.map_err(|e|e.to_string())?;
            let matching = previous.is_some_and(|row| {
                let raw: Option<String> = row.get("value");
                let old_value: Option<Value> = raw.and_then(|raw|serde_json::from_str(&raw).ok());
                let old_field: Option<String> = row.get("field");
                let old_kind: String = row.get("kind");
                let old_actor: String = row.get("actor");
                let old_entity: String = row.get("entity");
                row.get::<i64,_>("wall") == hlc.wall && row.get::<i64,_>("counter") == hlc.counter && old_actor == hlc.actor &&
                    old_entity == entity && old_kind == if field.is_some() {"set"} else {"del"} &&
                    old_field.as_deref() == field && old_value.as_ref() == value
            });
            if !matching { return Err("Operation history changed since the audit".into()); }
        }
    }
    for op in ops {
        let (id, hlc, entity, field, value) = op.parts();
        let previous = sqlx::query("SELECT * FROM oplog WHERE id=?")
            .bind(id).fetch_optional(&mut *transaction).await.map_err(|e|e.to_string())?;
        if let Some(row) = previous {
            let old_hlc = Timestamp { wall: row.get("wall"), counter: row.get("counter"), actor: row.get("actor") };
            let kind: String = row.get("kind");
            let old: Operation = if kind == "del" {
                Operation::Delete { id: row.get("id"), hlc: old_hlc, entity: row.get("entity") }
            } else {
                let raw: String = row.get("value");
                Operation::Set { id: row.get("id"), hlc: old_hlc, entity: row.get("entity"), field: row.get("field"),
                    value: serde_json::from_str(&raw).map_err(|e|e.to_string())? }
            };
            if &old != op { return Err(format!("Operation ID collision: {id}")); }
            continue;
        }
        if let Some(value) = value {
            let existing: Vec<String> = sqlx::query_scalar("SELECT value FROM oplog WHERE kind='set' AND entity=? AND field=? AND wall=? AND counter=? AND actor=?")
                .bind(entity).bind(field).bind(hlc.wall).bind(hlc.counter).bind(&hlc.actor)
                .fetch_all(&mut *transaction).await.map_err(|e|e.to_string())?;
            for raw in existing {
                if serde_json::from_str::<Value>(&raw).map_err(|e|e.to_string())? != *value {
                    return Err("Conflicting writes reuse an operation timestamp".into());
                }
            }
        }
        sqlx::query("INSERT INTO oplog(id,wall,counter,actor,kind,entity,field,value) VALUES (?,?,?,?,?,?,?,?)")
            .bind(id).bind(hlc.wall).bind(hlc.counter).bind(&hlc.actor)
            .bind(if field.is_some() {"set"} else {"del"}).bind(entity).bind(field)
            .bind(value.map(serde_json::to_string).transpose().map_err(|e|e.to_string())?)
            .execute(&mut *transaction).await.map_err(|e|e.to_string())?;
    }
    transaction.commit().await.map_err(|e|e.to_string())
}

#[tauri::command]
pub async fn append_operations(app: AppHandle, ops: Vec<Operation>, expected: Option<HistoryPrecondition>) -> Result<(), String> {
    let _maintenance = crate::backup::MAINTENANCE.lock().await;
    let path = app.path().app_config_dir().map_err(|e|e.to_string())?.join("cognote.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options).await.map_err(|e|e.to_string())?;
    append_checked(&mut db, &ops, expected).await
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct MutationResult { rows_affected: u64, last_insert_id: i64 }

async fn mutate(db: &mut SqliteConnection, query: &str, values: Vec<Value>) -> Result<MutationResult, String> {
    mutate_batch(db,vec![Statement {query:query.into(),values}]).await
}

#[derive(Deserialize)]
pub struct Statement { query: String, values: Vec<Value> }

async fn entities(db: &mut SqliteConnection) -> Result<Vec<Value>,String> {
    let mut rows = current_rows(db,"tasks").await?;
    for mut project in current_rows(db,"projects").await? {
        project["id"] = Value::String(format!("project:{}",project["id"].as_str().ok_or("Invalid project ID")?));
        rows.push(project);
    }
    Ok(rows)
}

async fn mutate_batch(db: &mut SqliteConnection, statements: Vec<Statement>) -> Result<MutationResult,String> {
    commit_batch(db,statements,true).await
}
async fn commit_batch(db: &mut SqliteConnection, statements: Vec<Statement>, record: bool) -> Result<MutationResult,String> {
    if statements.is_empty() || statements.len() > 50_000 { return Err("Invalid mutation batch".into()); }
    let mut tx = db.begin().await.map_err(|e|e.to_string())?;
    let before = entities(&mut tx).await?;
    let mut affected = 0;
    let mut insert_id = 0;
    for Statement { query, values } in statements {
        let normalized = query.trim().to_ascii_lowercase();
        if !(normalized.starts_with("insert") || normalized.starts_with("update tasks") || normalized.starts_with("delete from tasks") ||
            normalized.starts_with("update projects") || normalized.starts_with("delete from projects")) ||
            !(normalized.contains("tasks") || normalized.contains("projects")) || query.len() > 1_000_000 {
            return Err("Unsupported entity mutation".into());
        }
        let mut statement = sqlx::query(&query);
        for value in values {
            statement = match value {
                Value::Null => statement.bind(None::<String>),Value::Bool(value)=>statement.bind(value),
                Value::String(value)=>statement.bind(value),
                Value::Number(value) if value.is_i64()=>statement.bind(value.as_i64().unwrap()),
                Value::Number(value)=>statement.bind(value.as_f64().ok_or("Invalid SQL number")?),
                _=>return Err("Mutation parameters must be scalar values".into()),
            };
        }
        let result = statement.execute(&mut *tx).await.map_err(|e|e.to_string())?;
        affected += result.rows_affected(); insert_id = result.last_insert_rowid();
    }
    if !record {
        tx.commit().await.map_err(|e|e.to_string())?;
        return Ok(MutationResult {rows_affected:affected,last_insert_id:insert_id});
    }
    let tentative = current_rows(&mut tx,"tasks").await?;
    for task in tentative {
        let id = task["id"].as_str().ok_or("Invalid task ID")?;
        let was_open = before.iter().any(|old|old["id"]==task["id"] && old["done"]==Value::Bool(false));
        let recurrence = task["recurrence"].as_str().unwrap_or("none");
        if task["done"] != Value::Bool(true) || !was_open || recurrence == "none" { continue; }
        let base = task["deadline"].as_str().unwrap_or_default();
        let date = if base.is_empty() {chrono::Local::now().date_naive()} else {
            chrono::NaiveDate::parse_from_str(base,"%Y-%m-%d").map_err(|e|format!("Invalid recurrence date: {e}"))?
        };
        let next = match recurrence {
            "daily"=>date.checked_add_signed(chrono::Duration::days(1)),
            "weekly"=>date.checked_add_signed(chrono::Duration::days(7)),
            "monthly"=>date.checked_add_months(chrono::Months::new(1)),
            _=>return Err("Unsupported recurrence rule".into()),
        }.ok_or("Recurrence date overflow")?.to_string();
        let next_id = format!("{}:recurrence:{next}",id.split(":recurrence:").next().ok_or("Invalid recurrence identity")?);
        sqlx::query("INSERT OR IGNORE INTO tasks(id,title,description,tags,deadline,importance,effort,done,created_at,priority,sort_order,project_id,parent_id,recurrence,milestone_id,custom_fields,duration_min,energy,min_block,max_block)
            SELECT ?,title,description,tags,?,importance,effort,0,?,priority,(SELECT count(*) FROM tasks),project_id,parent_id,recurrence,milestone_id,custom_fields,duration_min,energy,min_block,max_block FROM tasks WHERE id=?")
            .bind(next_id).bind(next).bind(chrono::Utc::now().to_rfc3339()).bind(id)
            .execute(&mut *tx).await.map_err(|e|e.to_string())?;
    }
    let after = entities(&mut tx).await?;
    let actor: Option<String> = sqlx::query_scalar("SELECT value FROM app_state WHERE key='crdt_actor'")
        .fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
    let actor = if let Some(actor) = actor { actor } else {
        let actor: String = sqlx::query_scalar("SELECT lower(hex(randomblob(16)))").fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO app_state(key,value) VALUES ('crdt_actor',?)").bind(&actor).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        actor
    };
    let latest = sqlx::query("SELECT wall,counter FROM oplog ORDER BY wall DESC,counter DESC LIMIT 1")
        .fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    let (wall,mut counter) = latest.map(|row| (row.get::<i64,_>("wall").max(now),row.get::<i64,_>("counter"))).unwrap_or((now,0));
    let old: std::collections::HashMap<String,Value> = before.into_iter().map(|row|(row["id"].as_str().unwrap().to_string(),row)).collect();
    let new: std::collections::HashMap<String,Value> = after.into_iter().map(|row|(row["id"].as_str().unwrap().to_string(),row)).collect();
    let mut ops = Vec::new();
    let mut keys: Vec<_> = new.keys().collect(); keys.sort();
    for id in keys {
        let row = &new[id];
        if old.get(id) == Some(row) { continue; }
        for (field,value) in row.as_object().ok_or("Invalid task row")? {
            if field == "id" { continue; }
            counter = counter.checked_add(1).ok_or("Operation clock exhausted")?;
            ops.push(Operation::Set { id:format!("{wall}.{counter}.{actor}|set|{id}|{field}"),
                hlc:Timestamp {wall,counter,actor:actor.clone()},entity:id.clone(),field:field.clone(),value:value.clone() });
        }
    }
    let mut removed: Vec<_> = old.keys().filter(|id|!new.contains_key(*id)).collect(); removed.sort();
    for id in removed {
        counter = counter.checked_add(1).ok_or("Operation clock exhausted")?;
        ops.push(Operation::Delete { id:format!("{wall}.{counter}.{actor}|del|{id}|"),
            hlc:Timestamp {wall,counter,actor:actor.clone()},entity:id.clone() });
    }
    append_checked(&mut tx,&ops,None).await?;
    sqlx::query("INSERT INTO app_state(key,value) VALUES ('crdt_hlc',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(serde_json::to_string(&Timestamp {wall,counter,actor}).map_err(|e|e.to_string())?)
        .execute(&mut *tx).await.map_err(|e|e.to_string())?;
    tx.commit().await.map_err(|e|e.to_string())?;
    Ok(MutationResult {rows_affected:affected,last_insert_id:insert_id})
}

#[tauri::command]
pub async fn mutate_tasks(app: AppHandle, query: String, values: Vec<Value>) -> Result<MutationResult,String> {
    let _maintenance = crate::backup::MAINTENANCE.lock().await;
    let path = app.path().app_config_dir().map_err(|e|e.to_string())?.join("cognote.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options).await.map_err(|e|e.to_string())?;
    mutate(&mut db,&query,values).await
}

#[tauri::command]
pub async fn mutate_entity_batch(app: AppHandle, statements: Vec<Statement>) -> Result<MutationResult,String> {
    let _maintenance = crate::backup::MAINTENANCE.lock().await;
    let path = app.path().app_config_dir().map_err(|e|e.to_string())?.join("cognote.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options).await.map_err(|e|e.to_string())?;
    mutate_batch(&mut db,statements).await
}

#[cfg(test)]
async fn apply_projection(db: &mut SqliteConnection, ops: Vec<Operation>, tasks: Vec<Value>, projects: Vec<Value>, expected: HistoryPrecondition) -> Result<(),String> {
    apply_projection_with_identity(db,ops,tasks,projects,expected,None).await
}
#[derive(Deserialize)]
pub struct RecoveryIdentity {actor:String,pub_key:String,kit_id:String}
async fn apply_projection_with_identity(db:&mut SqliteConnection,ops:Vec<Operation>,tasks:Vec<Value>,projects:Vec<Value>,expected:HistoryPrecondition,recovery:Option<RecoveryIdentity>)->Result<(),String> {
    let mut tx = db.begin().await.map_err(|e|e.to_string())?;
    if recovery.is_some() && (!expected.tasks.is_empty() || !expected.projects.is_empty() || !expected.ops.is_empty()) {return Err("Identity recovery requires an empty workspace".into());}
    append_checked(&mut tx,&ops,Some(expected)).await?;
    let mut statements = vec![Statement {query:"DELETE FROM tasks".into(),values:vec![]},Statement {query:"DELETE FROM projects".into(),values:vec![]}];
    let task_fields = ["id","title","description","deadline","tags","importance","effort","priority","done","created_at","completed_at",
        "pomodoros_spent","project_id","parent_id","milestone_id","recurrence","sort_order","custom_fields","deleted_at",
        "duration_min","energy","pinned","scheduled_start","scheduled_end","min_block","max_block"];
    for (table,rows,fields) in [("projects",projects,&["id","name","color","created_at","sort_order"][..]),("tasks",tasks,&task_fields[..])] {
        for row in rows {
            let mut columns = Vec::new(); let mut values = Vec::new();
            for field in fields {
                if let Some(value) = row.get(*field) {
                    columns.push(*field);
                    values.push(if ["tags","custom_fields"].contains(field) {Value::String(serde_json::to_string(value).map_err(|e|e.to_string())?)} else {value.clone()});
                }
            }
            if !columns.contains(&"id") || columns.len()<2 {return Err("Invalid projected row".into());}
            let parameters = vec!["?";columns.len()].join(",");
            statements.push(Statement {query:format!("INSERT INTO {table}({}) VALUES ({parameters})",columns.join(",")),values});
        }
    }
    commit_batch(&mut tx,statements,false).await?;
    if let Some(identity)=recovery {
        let latest=sqlx::query("SELECT wall,counter FROM oplog ORDER BY wall DESC,counter DESC LIMIT 1").fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
        let now=chrono::Utc::now().timestamp_millis();
        let clock=Timestamp {actor:identity.actor.clone(),wall:latest.as_ref().map(|row|row.get::<i64,_>("wall").max(now)).unwrap_or(now),counter:latest.map(|row|row.get::<i64,_>("counter")+1).unwrap_or(0)};
        sqlx::query("INSERT INTO app_state(key,value) VALUES ('crdt_hlc',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(serde_json::to_string(&clock).map_err(|e|e.to_string())?).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        for (key,value) in [("recovery_completed_data",identity.kit_id),("crdt_actor",identity.actor.clone()),("crdt_signing_pub",identity.pub_key.clone()),("crdt_signing_binding",serde_json::json!({"actor":identity.actor,"pub":identity.pub_key}).to_string())] {
            sqlx::query("INSERT INTO app_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key).bind(value).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        }
    }
    tx.commit().await.map_err(|e|e.to_string())
}

#[tauri::command]
pub async fn commit_projection(app: AppHandle, ops: Vec<Operation>, tasks: Vec<Value>, projects: Vec<Value>, expected: HistoryPrecondition, recovery:Option<RecoveryIdentity>) -> Result<(),String> {
    let _maintenance = crate::backup::MAINTENANCE.lock().await;
    let path = app.path().app_config_dir().map_err(|e|e.to_string())?.join("cognote.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options).await.map_err(|e|e.to_string())?;
    apply_projection_with_identity(&mut db,ops,tasks,projects,expected,recovery).await
}

async fn planning_state(db: &mut SqliteConnection) -> Result<Value,String> {
    let tasks = current_rows(db,"tasks").await?;
    let calendar: Vec<String> = sqlx::query_scalar("SELECT json_object('id',id,'title',title,'start',start,'end',end,'source',source,'created_at',created_at) FROM calendar_events ORDER BY id")
        .fetch_all(&mut *db).await.map_err(|e|e.to_string())?;
    let calendar: Vec<Value> = calendar.into_iter().map(|raw|serde_json::from_str(&raw).map_err(|e|e.to_string())).collect::<Result<_,_>>()?;
    let rows = sqlx::query("SELECT key,value FROM app_state WHERE key IN ('use_custom_work_hours','work_start_min','work_end_min','wake_start_min','wake_end_min') OR key LIKE 'plan:%'")
        .fetch_all(&mut *db).await.map_err(|e|e.to_string())?;
    let settings: serde_json::Map<String,Value> = rows.into_iter().map(|row|(row.get("key"),Value::String(row.get("value")))).collect();
    Ok(serde_json::json!({"tasks":tasks,"calendar":calendar,"settings":settings}))
}

async fn save_plan(db: &mut SqliteConnection, date: &str, result: crate::planner::PlanResult, expected: Value, record: String) -> Result<(),String> {
    let day = chrono::NaiveDate::parse_from_str(date,"%Y-%m-%d").map_err(|e|e.to_string())?;
    let mut tx = db.begin().await.map_err(|e|e.to_string())?;
    if planning_state(&mut tx).await? != expected { return Err("Tasks, calendar, or working hours changed while planning. Retry the plan.".into()); }
    let mut statements = vec![Statement {query:"UPDATE tasks SET scheduled_start=NULL,scheduled_end=NULL WHERE substr(scheduled_start,1,10)=? AND pinned=0 AND done=0 AND deleted_at IS NULL".into(),values:vec![Value::String(date.into())]}];
    if result.pin.as_ref().is_some_and(|pin|pin.duration_min==0 || pin.duration_min>1440 || !result.blocks.iter().any(|b|b.task_id==pin.task_id)) {return Err("Invalid pin override".into());}
    let mut ids = std::collections::HashSet::new();
    for block in result.blocks {
        if block.start_min>=block.end_min || block.end_min>1440 || !ids.insert(block.task_id.clone()) {return Err("Invalid planned block".into());}
        let start = day.and_hms_opt(0,0,0).unwrap()+chrono::Duration::minutes(i64::from(block.start_min));
        let end = day.and_hms_opt(0,0,0).unwrap()+chrono::Duration::minutes(i64::from(block.end_min));
        let is_pin = result.pin.as_ref().is_some_and(|pin|pin.task_id==block.task_id);
        if is_pin {
            statements.push(Statement {query:"UPDATE tasks SET pinned=1,duration_min=? WHERE id=?".into(),values:vec![serde_json::json!(result.pin.as_ref().unwrap().duration_min),Value::String(block.task_id.clone())]});
        }
        statements.push(Statement {query:"UPDATE tasks SET scheduled_start=?,scheduled_end=? WHERE id=? AND done=0 AND deleted_at IS NULL".into(),values:vec![Value::String(start.format("%Y-%m-%dT%H:%M:%S").to_string()),Value::String(end.format("%Y-%m-%dT%H:%M:%S").to_string()),Value::String(block.task_id)]});
    }
    mutate_batch(&mut tx,statements).await?;
    sqlx::query("INSERT INTO app_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(format!("plan:{date}")).bind(record).execute(&mut *tx).await.map_err(|e|e.to_string())?;
    tx.commit().await.map_err(|e|e.to_string())
}

#[tauri::command]
pub async fn planning_snapshot(app: AppHandle) -> Result<Value,String> {
    let _maintenance = crate::backup::MAINTENANCE.lock().await;
    let path = app.path().app_config_dir().map_err(|e|e.to_string())?.join("cognote.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options).await.map_err(|e|e.to_string())?;
    let mut tx = db.begin().await.map_err(|e|e.to_string())?;
    let snapshot = planning_state(&mut tx).await?;
    tx.commit().await.map_err(|e|e.to_string())?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn commit_plan(app: AppHandle, date: String, result: crate::planner::PlanResult, expected: Value, record: String) -> Result<(),String> {
    let _maintenance = crate::backup::MAINTENANCE.lock().await;
    let path = app.path().app_config_dir().map_err(|e|e.to_string())?.join("cognote.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options).await.map_err(|e|e.to_string())?;
    save_plan(&mut db,&date,result,expected,record).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CalendarRow { id: String, title: String, start: String, end: String, source: String, created_at: String }

async fn replace_calendar(db: &mut SqliteConnection, source: &str, events: Vec<CalendarRow>, metadata: Option<Value>) -> Result<(),String> {
    if !token(source,128) || events.len()>50_000 { return Err("Invalid calendar source or event count".into()); }
    for event in &events {
        let parse = |s:&str| chrono::DateTime::parse_from_rfc3339(s).map(|date|date.naive_utc())
            .or_else(|_|chrono::NaiveDateTime::parse_from_str(s,"%Y-%m-%dT%H:%M:%S")).map_err(|e|e.to_string());
        let start = parse(&event.start)?;
        let end = parse(&event.end)?;
        if end<=start || event.source!=source || !token(&event.id,512) { return Err("Invalid calendar interval or identity".into()); }
    }
    let mut tx = db.begin().await.map_err(|e|e.to_string())?;
    sqlx::query("DELETE FROM calendar_events WHERE source=?").bind(source).execute(&mut *tx).await.map_err(|e|e.to_string())?;
    for event in events {
        sqlx::query("INSERT INTO calendar_events(id,title,start,end,source,created_at) VALUES (?,?,?,?,?,?)")
            .bind(event.id).bind(event.title).bind(event.start).bind(event.end).bind(event.source).bind(event.created_at)
            .execute(&mut *tx).await.map_err(|e|e.to_string())?;
    }
    if let Some(metadata)=metadata {
        sqlx::query("INSERT INTO app_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(format!("calendar_meta:{source}")).bind(serde_json::to_string(&metadata).map_err(|e|e.to_string())?)
            .execute(&mut *tx).await.map_err(|e|e.to_string())?;
    }
    tx.commit().await.map_err(|e|e.to_string())
}

#[tauri::command]
pub async fn replace_calendar_source(app: AppHandle, source: String, events: Vec<CalendarRow>, metadata: Option<Value>) -> Result<(),String> {
    let _maintenance = crate::backup::MAINTENANCE.lock().await;
    let path = app.path().app_config_dir().map_err(|e|e.to_string())?.join("cognote.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options).await.map_err(|e|e.to_string())?;
    replace_calendar(&mut db,&source,events,metadata).await
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn db() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../migrations/006_oplog.sql")).execute(&mut db).await.unwrap();
        db
    }
    fn op(id: &str, value: &str) -> Operation {
        Operation::Set { id: id.into(), hlc: Timestamp {wall: 1, counter: 1, actor:"device".into()},
            entity: "task".into(), field:"title".into(), value:Value::String(value.into()) }
    }
    #[tokio::test]
    async fn collision_rolls_back_the_whole_batch() {
        let mut db = db().await;
        append(&mut db, &[op("existing","old")]).await.unwrap();
        let mut next = op("new","other");
        if let Operation::Set { hlc, .. } = &mut next { hlc.counter = 2; }
        assert!(append(&mut db, &[next, op("existing","changed")]).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM oplog").fetch_one(&mut db).await.unwrap();
        assert_eq!(count,1);
    }
    #[tokio::test]
    async fn replay_dedupes_but_conflicting_timestamps_fail() {
        let mut db = db().await;
        append(&mut db, &[op("id","old"),op("id","old")]).await.unwrap();
        assert!(append(&mut db, &[op("different-id","changed")]).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM oplog").fetch_one(&mut db).await.unwrap();
        assert_eq!(count,1);
    }
    async fn task_db() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for script in [include_str!("../migrations/001_init.sql"),include_str!("../migrations/002_projects.sql"),
            include_str!("../migrations/003_milestones.sql"),include_str!("../migrations/004_trash.sql"),
            include_str!("../migrations/005_schedule.sql"),include_str!("../migrations/006_oplog.sql")] {
            sqlx::raw_sql(script).execute(&mut db).await.unwrap();
        }
        sqlx::query("INSERT INTO tasks(id,title,created_at) VALUES ('task','original','2026-10-06')").execute(&mut db).await.unwrap();
        db
    }
    #[tokio::test]
    async fn failed_operation_insert_rolls_back_task_edit_and_identity() {
        let mut db = task_db().await;
        sqlx::raw_sql("CREATE TRIGGER fail_ops BEFORE INSERT ON oplog BEGIN SELECT RAISE(ABORT,'injected failure'); END;")
            .execute(&mut db).await.unwrap();
        assert!(mutate(&mut db,"UPDATE tasks SET title=? WHERE id=?",vec![Value::String("edited".into()),Value::String("task".into())]).await.is_err());
        let title: String = sqlx::query_scalar("SELECT title FROM tasks").fetch_one(&mut db).await.unwrap();
        assert_eq!(title,"original");
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM oplog").fetch_one(&mut db).await.unwrap();
        assert_eq!(count,0);
        let actor: i64 = sqlx::query_scalar("SELECT count(*) FROM app_state WHERE key='crdt_actor'").fetch_one(&mut db).await.unwrap();
        assert_eq!(actor,0);
    }
    #[tokio::test]
    async fn successful_task_command_commits_full_history_and_clock() {
        let mut db = task_db().await;
        mutate(&mut db,"UPDATE tasks SET title='committed'",vec![]).await.unwrap();
        let value: String = sqlx::query_scalar("SELECT value FROM oplog WHERE field='title'").fetch_one(&mut db).await.unwrap();
        assert_eq!(value,"\"committed\"");
        let counter: i64 = sqlx::query_scalar("SELECT MAX(counter) FROM oplog").fetch_one(&mut db).await.unwrap();
        let clock: String = sqlx::query_scalar("SELECT value FROM app_state WHERE key='crdt_hlc'").fetch_one(&mut db).await.unwrap();
        assert_eq!(serde_json::from_str::<Timestamp>(&clock).unwrap().counter,counter);
        mutate(&mut db,"DELETE FROM tasks WHERE id='task'",vec![]).await.unwrap();
        let tombstones: i64 = sqlx::query_scalar("SELECT count(*) FROM oplog WHERE kind='del'").fetch_one(&mut db).await.unwrap();
        assert_eq!(tombstones,1);
    }
    #[tokio::test]
    async fn stale_historical_audit_cannot_append_repairs() {
        let mut db = task_db().await;
        let expected = HistoryPrecondition {tasks:current_rows(&mut db,"tasks").await.unwrap(),
            projects:current_rows(&mut db,"projects").await.unwrap(),ops:vec![]};
        sqlx::query("UPDATE tasks SET title='concurrent edit'").execute(&mut db).await.unwrap();
        assert!(append_checked(&mut db,&[op("repair","old")],Some(expected)).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM oplog").fetch_one(&mut db).await.unwrap();
        assert_eq!(count,0);
    }

    #[tokio::test]
    async fn projection_insert_failure_retains_rows_and_history() {
        let mut db = task_db().await;
        let tasks = current_rows(&mut db,"tasks").await.unwrap();
        let expected = HistoryPrecondition {tasks:tasks.clone(), projects:vec![], ops:vec![]};
        let mut replacement = tasks.clone();
        replacement[0]["title"] = Value::String("remote".into());
        sqlx::raw_sql("CREATE TRIGGER fail_projection BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'injected failure'); END;")
            .execute(&mut db).await.unwrap();
        assert!(apply_projection(&mut db,vec![op("remote","remote")],replacement,vec![],expected).await.is_err());
        assert_eq!(current_rows(&mut db,"tasks").await.unwrap(),tasks);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM oplog").fetch_one(&mut db).await.unwrap();
        assert_eq!(count,0);
    }
    #[tokio::test]
    async fn failed_calendar_refresh_keeps_previous_busy_events() {
        let mut db = task_db().await;
        sqlx::query("INSERT INTO calendar_events(id,title,start,end,source,created_at) VALUES ('old','Busy','2026-10-06T09:00:00','2026-10-06T10:00:00','ics','today')")
            .execute(&mut db).await.unwrap();
        sqlx::raw_sql("CREATE TRIGGER fail_calendar BEFORE INSERT ON calendar_events BEGIN SELECT RAISE(ABORT,'injected failure'); END;")
            .execute(&mut db).await.unwrap();
        let event = CalendarRow {id:"new".into(),title:"New".into(),start:"2026-10-06T11:00:00".into(),end:"2026-10-06T12:00:00".into(),source:"ics".into(),created_at:"today".into()};
        assert!(replace_calendar(&mut db,"ics",vec![event],None).await.is_err());
        let id: String = sqlx::query_scalar("SELECT id FROM calendar_events").fetch_one(&mut db).await.unwrap();
        assert_eq!(id,"old");
    }

    fn result() -> crate::planner::PlanResult {
        crate::planner::PlanResult {pin:Some(crate::planner::PlanPin {task_id:"task".into(),duration_min:60}),blocks:vec![crate::planner::Block {task_id:"task".into(),start_min:600,end_min:660,reason:"Best slot".into()}],unscheduled:vec![]}
    }
    #[tokio::test]
    async fn stale_plan_does_not_erase_concurrent_edits() {
        let mut db = task_db().await;
        let expected = planning_state(&mut db).await.unwrap();
        mutate(&mut db,"UPDATE tasks SET title='concurrent'",vec![]).await.unwrap();
        assert!(save_plan(&mut db,"2026-10-06",result(),expected,"{}".into()).await.is_err());
        let title: String = sqlx::query_scalar("SELECT title FROM tasks").fetch_one(&mut db).await.unwrap();
        assert_eq!(title,"concurrent");
        let plans: i64 = sqlx::query_scalar("SELECT count(*) FROM app_state WHERE key LIKE 'plan:%'").fetch_one(&mut db).await.unwrap();
        assert_eq!(plans,0);
    }
    #[tokio::test]
    async fn failed_plan_explanation_write_rolls_back_schedule_and_history() {
        let mut db = task_db().await;
        let expected = planning_state(&mut db).await.unwrap();
        sqlx::raw_sql("CREATE TRIGGER fail_plan BEFORE INSERT ON app_state WHEN NEW.key LIKE 'plan:%' BEGIN SELECT RAISE(ABORT,'injected failure'); END;")
            .execute(&mut db).await.unwrap();
        assert!(save_plan(&mut db,"2026-10-06",result(),expected,"{}".into()).await.is_err());
        let start: Option<String> = sqlx::query_scalar("SELECT scheduled_start FROM tasks").fetch_one(&mut db).await.unwrap();
        assert_eq!(start,None);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM oplog").fetch_one(&mut db).await.unwrap();
        assert_eq!(count,0);
    }

    #[tokio::test]
    async fn identity_recovery_rolls_back_history_and_binding_when_marker_write_fails() {
        let mut db=task_db().await;
        let replacement=current_rows(&mut db,"tasks").await.unwrap();
        sqlx::query("DELETE FROM tasks").execute(&mut db).await.unwrap();
        sqlx::raw_sql("CREATE TRIGGER fail_recovery BEFORE INSERT ON app_state WHEN NEW.key='recovery_completed_data' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").execute(&mut db).await.unwrap();
        let identity=RecoveryIdentity {actor:"recovered".into(),pub_key:"pub".into(),kit_id:"kit".into()};
        assert!(apply_projection_with_identity(&mut db,vec![op("recovered-op","original")],replacement,vec![],HistoryPrecondition {tasks:vec![],projects:vec![],ops:vec![]},Some(identity)).await.is_err());
        assert!(current_rows(&mut db,"tasks").await.unwrap().is_empty());
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM oplog").fetch_one(&mut db).await.unwrap(),0);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM app_state").fetch_one(&mut db).await.unwrap(),0);
    }
    #[tokio::test]
    async fn calendar_metadata_and_events_commit_together() {
        let mut db=task_db().await;
        let event=CalendarRow {id:"fresh".into(),title:"Busy".into(),start:"2026-10-06T09:00:00Z".into(),end:"2026-10-06T10:00:00Z".into(),source:"ics".into(),created_at:"today".into()};
        sqlx::raw_sql("CREATE TRIGGER fail_calendar_metadata BEFORE INSERT ON app_state WHEN NEW.key='calendar_meta:ics' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").execute(&mut db).await.unwrap();
        assert!(replace_calendar(&mut db,"ics",vec![event],Some(serde_json::json!({"v":2}))).await.is_err());
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM calendar_events").fetch_one(&mut db).await.unwrap(),0);
    }

}
