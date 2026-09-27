<?php
// Adversarial: nested defaults, array defaults, same-line declaration.
class Svc {
    public function nestedDefault($a = g(1, 2), $b = [1, 2]) {
        return $a;
    }
    public function arrayDefault($a = ['k' => 'v'], $b = 2) {
        return $b;
    }
    public function stringDelims($sep = ")") {
        return $sep;
    }
}
