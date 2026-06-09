//go:build !windows

package main

func modemPorts() map[string]string {
	return map[string]string{}
}
