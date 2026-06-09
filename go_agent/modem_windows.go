//go:build windows

package main

import (
	"os/exec"
	"strings"
)

// modemPorts returns a map of COM port name → friendly name
// for modems that are currently present (Status=OK) in Device Manager.
func modemPorts() map[string]string {
	result := map[string]string{}

	// Status=OK → 현재 연결된(인식된) 장치만 반환
	ps := `Get-PnpDevice -Class Modem -Status OK -ErrorAction SilentlyContinue | ` +
		`ForEach-Object { ` +
		`  $p = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Enum\$($_.InstanceId)\Device Parameters" -ErrorAction SilentlyContinue).PortName; ` +
		`  if ($p) { "$($_.FriendlyName)|$p" } ` +
		`}`

	out, err := exec.Command("powershell", "-NoProfile", "-Command", ps).Output()
	if err != nil || len(out) == 0 {
		return result
	}

	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		parts := strings.SplitN(line, "|", 2)
		if len(parts) == 2 && parts[1] != "" {
			port := strings.TrimSpace(parts[1])
			name := strings.TrimSpace(parts[0])
			result[port] = name
		}
	}
	return result
}
