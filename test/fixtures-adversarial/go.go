// Adversarial control: go uses the shared balanced scanner.
package main

func ClosureParam(a int, b func(int) int) int {
	return b(a)
}

func DeepGenerics(m map[string][]int) int {
	return len(m)
}
