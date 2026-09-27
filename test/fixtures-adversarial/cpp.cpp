// Adversarial: nested defaults, templates, function-pointer params.
int nested_default(int a, int b = g(1, 2)) {
    return a + b;
}
int deep_templates(std::map<std::string, std::vector<int>> m) {
    return 0;
}
int fn_pointer(int (*cb)(int), int n) {
    return cb(n);
}
