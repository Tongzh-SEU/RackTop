use crate::collector::{parse_snapshot};
use std::io::Write;
use std::process::{Command, Stdio};

fn run_helper(info: &str, function: &str) -> String {
    let shell = if cfg!(windows) { "C:/Program Files/Git/bin/bash.exe" } else { "sh" };
    let mut child = Command::new(shell).arg("-s").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("shell for collector regression tests");
    let script = format!("{}\nracktop_npu_info=$(cat <<'RACKTOP_FIXTURE'\n{}\nRACKTOP_FIXTURE\n)\n{}\n", include_str!("../assets/ascend-collector.sh"), info, function);
    child.stdin.take().unwrap().write_all(script.replace("\r\n", "\n").as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn real_ascend_table_preserves_hbm_and_all_processes() {
    let info = include_str!("../assets/test-fixtures/npu-smi-24.1.0.txt");
    let metrics = run_helper(info, "racktop_npu_metrics");
    let processes = run_helper(info, "racktop_npu_processes");
    let snapshot = parse_snapshot("npu", &format!("__RACKTOP_USER__\njovyan\n__RACKTOP_HOST__\nnpu-test\n__RACKTOP_CPU1__\ncpu 1 0 0 9\n__RACKTOP_CPU2__\ncpu 2 0 0 18\n__RACKTOP_MEM__\nMemTotal: 1000 kB\nMemAvailable: 500 kB\n__RACKTOP_ACCELERATOR__\nascend\n__RACKTOP_NVIDIA__\navailable\n__RACKTOP_GPU__\n{metrics}__RACKTOP_GPUPROC__\n{processes}__RACKTOP_END__\n")).unwrap();
    assert_eq!(snapshot.gpus.len(), 16);
    assert_eq!(snapshot.gpus[0].memory_used_mb, 54469.0);
    assert_eq!(snapshot.gpus[0].memory_total_mb, 65536.0);
    assert_eq!(snapshot.gpus[0].health_status.as_deref(), Some("OK"));
    assert_eq!(snapshot.processes.len(), 20);
    assert_eq!(snapshot.processes[1].memory_used_mb, 51005.0);
    assert!(snapshot.processes.iter().all(|p| snapshot.gpus.iter().any(|g| g.uuid == p.gpu_uuid)));
}

#[test]
fn hbm_slash_spacing_and_nonzero_aicore_are_equivalent() {
    let header="| 2 910B2C | OK | 90.6 44 0 / 0 |\n";
    for usage in ["37 0 / 0 54469/ 65536", "37 0/0 54469 /65536", "37 0 / 0 54469 / 65536", "37 0/0 54469/65536"] {
        let output=run_helper(&format!("{header}| 0 | 0000:5A:00.0 | {usage} |"), "racktop_npu_metrics");
        assert!(output.contains("NPU-2-0, 37.00, 83.11, 54469.00, 65536.00"), "{output}");
    }
}

#[test]
fn legacy_column_layout_and_chip_ids_remain_supported() {
    let output=run_helper("| 2 | 910B | OK | 90.6 | 44 | 0 / 0 |\n| 2 | 1 | 0000:5A:00.0 | 25 | 0 / 0 | 8192/65536 |\n| 2 | 1 | 4242 | python | 8000 |", "racktop_npu_metrics; racktop_npu_processes");
    assert!(output.contains("NPU-2-1, 25.00, 12.50, 8192.00, 65536.00"), "{output}");
    assert!(output.contains("NPU-2-1, 4242, python, 8000.00"), "{output}");
}

#[test]
fn unavailable_hbm_is_not_reported_as_an_empty_healthy_card() {
    let output=run_helper("| 0 910B2C | OK | 90 44 0 / 0 |\n| 0 | 0000:5A:00.0 | 0 0 / 0 N/A / N/A |", "racktop_npu_metrics; racktop_npu_processes");
    assert!(output.contains("unavailable-NPU-0-0"), "{output}");
    assert_eq!(output.lines().count(),1);
}
