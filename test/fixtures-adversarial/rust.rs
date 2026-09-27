// Adversarial: closure types in params, nested generics, where clauses.
pub fn closure_param(a: i32, b: Box<dyn Fn(i32) -> i32>) -> i32 {
    b(a)
}
pub fn deep_generics(v: Vec<Box<dyn Fn(i32) -> i32>>) -> usize {
    v.len()
}
pub fn nested_result(x: Result<Option<Vec<i32>>, String>) -> usize {
    0
}
