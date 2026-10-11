//! Test/benchmark runner over the production Rust planner; never opens app data.
#[allow(dead_code)]
#[path = "../planner.rs"]
mod planner;
use std::io::Read;

fn main() {
    let mut input = String::new();
    std::io::stdin().take(32 * 1024 * 1024).read_to_string(&mut input).expect("read fixture input");
    let requests: Vec<serde_json::Value> = serde_json::from_str(&input).expect("valid fixture JSON");
    assert!(requests.len() <= 1000, "too many fixtures");
    let results: Vec<_> = requests.iter().map(|request| {
        serde_json::from_value::<planner::PlanRequest>(request.clone()).map_err(|_| "invalid planner input")
            .and_then(|request| planner::validate(&request).map(|_| planner::plan(&request)).map_err(|_| "invalid planner input"))
    }).collect();
    println!("{}", serde_json::to_string(&results).expect("encode fixture output"));
}
